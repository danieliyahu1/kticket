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

## e. Exact silverc `script_public_key` byte layout — **real compiler (KTK-88)**

The real silverscript-lang toolchain shipped, so the hand-rolled `silverc.mjs`
stub is gone (KTK-88 A3). Contracts (`contracts/event.sil`, `contracts/burn.sil`)
compile via the `kticket-silverc` Rust wrapper (A1/A2) into a
`kticket/compiled-contract/v2` artifact:

```
artifact = { bytecode, state_layout: {start,len}, template_hash,
             abi: [{name, dispatch_tag, inputs}],
             compiler_version, silverscript_rev }
redeem_script(state) = bytecode with the push-encoded state injected into
                       bytecode[state_layout.start .. start+len]
```

- The per-event constants (authorizing_txid, price, org_spk, burn_template_hash)
  are constructor args baked into the bytecode at compile time, so **each event
  requires its own compile** (KTK-88 A5 — the API compiles per event).
- `template_hash = hash(prefix || suffix)` (BLAKE3, 8-byte length-prefixed
  parts) — the `burn_template_hash` stored in the event constants and checked
  by the `use` entrypoint via `validateOutputStateWithTemplate`.
- The on-chain output remains standard Kaspa P2SH `aa20 <blake3(redeem)> 87`
  (blake3-32, `AddressVersion.ScriptHash` = 8), and the reader reads the state
  slot out of the redeem script via `state_layout` — it no longer uses
  `decodePreimage`. The placeholder `00 51` / `00 00` code no longer appears
  anywhere.
- `kticket-silverc` pins SilverScript v1-rc1 (`c7d17a1`) in its `Cargo.toml`; a CI
  check (KTK-88 A7) diffs committed artifacts against upstream to surface
  breaking changes deliberately.

**Open question (e) is closed by KTK-88.**

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

## f. mark_used door transition — **new events only (bytecode change)**

The door flow (KTK-118/119, parent KTK-119) adds two things to the Event
contract: a `byte[32] org_pkh` constructor constant (the organizer pubkey the
gate co-signature must verify against) and a `bool used` state field (the
door's "has this ticket entered?" flag). Both are baked into the compiled
bytecode:

- `mark_used(State prev_state, sig s, sig g)` is declared exactly like
  `transfer` — `#[covenant(binding = auth, from = 1, to = 1, mode = transition)]`
  — so it routes through the standard auth-entrypoint path and produces a
  sig-script `push(65B sig_owner) || push(65B sig_gate) || push(dispatch_tag) ||
  push(redeem)`. `sig` is a first-class 65-byte type; both `checkSig` calls
  verify against the same covenant-input sighash.
- **Constraint — new events only.** Because `org_pkh` and `used` change the
  event bytecode, any event **deployed before this change no longer
  verifies** against the current artifact (`verifyEventFromChain` recomputes
  the deploy output's P2SH address from the recompiled artifact and compares).
  Only events deployed with the new contract can be verified and used by the
  door flow. Documented here so operations knows a bytecode change invalidates
  old testnet events rather than "something broke".
- **Proof of node VM execution.** `packages/kit/silverc/tests/buy_covenant.rs`
  (`mark_used_covenant_passes_on_chain_vm`) compiles the real contract,
  injects `used: false` → `used: true` state, co-signs the ticket input with
  two real Schnorr keys (owner + organizer), and runs the node's covenant VM on
  input 0 — green only when the full transition passes on-chain. Compute budget
  is the standard `COMPUTE_BUDGET = 50` (500,000 script units), well above the
  two sigops + pushed bytes the transition needs.

## Statuses

| Question | Resolution | Where |
| --- | --- | --- |
| KIP-20 per-output vs per-family | **per-family** | `src/runtime/covenant.ts`, `builder.ts` |
| silverc script layout | pinned as placeholder `code` field | `artifacts/*.artifact.json`, `address.ts` |
| kaspa-wasm v1 covenant API | exists upstream, unpublished | `tx.ts` types + decision above |
| mark_used door transition | **new events only** (bytecode change) | `contracts/event.sil`, section f above |
