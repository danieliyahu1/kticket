# Spike decision note — Covenant runtime (KTK-3 / KTK-22)

Resolves the three open questions from HLD v0.21 §4 that block the Covenant
WASM kit runtime. Sources were read at `kaspanet/rusty-kaspa@master`
(commit `a41a333`), `kaspanet/kips` (KIP-17, KIP-20), and the published
`kaspa` / `kaspa-wasm` npm packages.

## d. KIP-20: per-output vs per-family `covenant_id` — **per-family**

Verified against the KIP-20 spec and the reference implementation
(`consensus/core/src/hashing/covenant_id.rs`, `covenant_id(O, auth_outputs)`).

- Genesis outputs are validated **grouped by `(authorizing_input,
  covenant_id)`**. All genesis outputs authorized by one input that carry the
  same `covenant_id` form one group, and the group's id is
  `CovenantIDHash(O, auth_outputs)` — the hash of the authorizing outpoint plus
  the *whole* ordered output list. So one event fanout → one `event_cov_id`
  shared by every ticket.
- Continuation outputs (buy/transfer/handover) must simply carry the same
  `covenant_id` as the spent ticket UTXO. Capacity is enforced by construction:
  you can't mint a ticket outside the genesis group without a genesis preimage.
- **Decision:** the kit pins per-family ids. `buildGenesis` computes
  `event_cov_id` and binds every ticket output to it; `buildBuy` /
  `buildTransfer` / `buildHandover` take it as the spent ticket's covenant id.
  `covenantId()` (`src/runtime/covenant.ts`) implements the KIP-20 hash:
  BLAKE2b-256 keyed with the `"CovenantID"` domain tag, LE integers, `varbytes`
  length prefixes.

## e. Exact silverc `script_public_key` byte layout — **pinned (placeholder)**

The published silverc toolchain does not exist yet; this repo's `silverc.mjs`
compiles contracts to a WASM artifact for the transition interpreter. The
on-chain redeem script is *not* that WASM. Per HLD §2.1:

```
redeem_script = OP_PUSH(state_bytes) OP_PUSH(constants_bytes) <silverc code>
```

- `state_bytes`    = `u8 phase | byte[32] owner` (ticket) / `u8 count` (burn)
- `constants_bytes`= `byte[32] event_id | u32 index | u64 price | varbytes org_spk
  | byte[32] burn_template_hash` (ticket) / `byte[32] event_id` (burn)
- push encoding: Bitcoin/Kaspa pushdata (direct, OP_PUSHDATA1, OP_PUSHDATA2).
- `<silverc code>`: the artifact now carries a `code` field (hex). For the
  reference compiler this is a **deterministic placeholder** — `00 51`
  (ticket) / `00 00` (burn) — so addresses are stable and testable today.
  The exact bytecode silverc emits for on-chain covenants remains a follow-up
  the day the real compiler ships; the runtime already reads it from the
  artifact, so swapping the value is a build-time change only.

**Address derivation** — the kit uses `P2SH(blake3(redeem_script))` (blake3-32,
32-byte ScriptHash payload). The HLD formula mentions `hash160(blake3(...))`,
but the current consensus reference derives P2SH from a **32-byte blake3**
script hash (`pay_to_script_hash_script` in `crypto/txscript/src/standard.rs`;
`AddressVersion.ScriptHash = 8`, 32-byte payload) and Kaspa addresses reject
20-byte ScriptHash payloads. Using `hash160` here would produce addresses the
network cannot spend. If the pinned layout ever changes to hash160, swap the
default in `scriptHash()` (`src/runtime/address.ts`) — it is a single function.

## c. kaspa-wasm v1 covenant tx-builder API — **exists upstream, not published**

The upstream WASM bindings have the full covenant surface, but **no published
npm release contains it** (latest `kaspa@0.13.0` / `kaspa-wasm@0.13.0` are
from 2023-11, pre-covenant; confirmed by inspecting the tarballs — no
`CovenantBinding`, no `covenantId`).

Upstream API (master, `wasm/examples/.../covenants.js` +
`consensus/client/src/covenant.rs`):

- `CovenantBinding { authorizingInput: u16, covenantId: HexString }`
- `GenesisCovenantGroup { authorizingInput: number, outputs: number[] }`
- `tx.populateGenesisCovenants(groups)` — computes ids and binds outputs
- `covenantId(outpoint, authOutputs)` — computes one id (same as our `covenantId`)
- tx v1: `new Transaction({ version: 1, inputs, outputs, lockTime, gas, payload, subnetworkId })`

**Decision:** the kit stays pure TS and emits plain `UnsignedTransaction`
templates (`src/runtime/tx.ts`). The kaspa-wasm v1 class serialization is a
thin, out-of-tree adapter (API layer, KTK-6) mapped onto these types once a
release with covenants ships. No runtime dependency on `kaspa` was added —
`@noble/hashes` provides the crypto primitives in pure TS instead.

## Statuses

| Question | Resolution | Where |
| --- | --- | --- |
| KIP-20 per-output vs per-family | **per-family** | `src/runtime/covenant.ts`, `builder.ts` |
| silverc script layout | pinned as placeholder `code` field | `artifacts/*.artifact.json`, `address.ts` |
| kaspa-wasm v1 covenant API | exists upstream, unpublished | `tx.ts` types + decision above |
