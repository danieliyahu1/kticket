# Decision note — KCC-20 Final conformance gap (KTK-179)

Status: **Accepted — stay KCC20-fork** · 2026-10-27.

Reviewed against [KCC-20 "Fungible Token Covenant Specification"
Final](https://github.com/kaspanet/kccs/blob/main/kcc-0020.md) (created
2026-08-21), [KCC-1](https://github.com/kaspanet/kccs/blob/main/kcc-0001.md),
[KCC-2](https://github.com/kaspanet/kccs/blob/main/kcc-0002.md), and
[KIP-20](https://github.com/kaspanet/kips/blob/master/kip-0020.md).

## Decision

kticket's ticket covenant is a **KCC20-fork**. It is a fork of forge's
pre-Final 4-field token layout, not an implementation of KCC-20 Final. We keep
the fork and the name, and no public surface — README, agent guide, OpenAPI
contract, or code comment — claims KCC-20 conformance.

Rewriting the covenant is **out of scope** for this note. Adopt KCC-20 only if
wallet or explorer discovery requires a KCC-20 program artifact (see
[Follow-up](#follow-up)).

## What Final specifies

A KCC-20 state is a `KCC20State` record with these fields, in order:

```text
KCC20State {
    amount:               int
    owner:                byte[32]
    owner_scheme:         byte
    borrow_scheme:        byte
    borrow_guard:         byte[32]
    extension_commitment: byte[32]
}
```

The default configuration uses `transfer(KCC20State[], byte[])` (leader) and
`transfer_delegator(byte[])` (every other input in the covenant family). It
recognizes owner schemes `0x00`–`0x04` (`p2pk-schnorr/v1`, `p2pkh-schnorr/v1`,
`p2pkh-ecdsa/v1`, `p2sh/v1`, `covenant-id/v1`) and borrow schemes `0x00`–`0x03`
(disabled, amount-threshold, schnorr-signature, hash-chain). A standard
transfer preserves the family's total `amount` and every state's
`extension_commitment`; extended (application) state lives behind that digest.
The covenant must publish a program artifact describing the state locations,
entrypoints, supported schemes, and transfer bounds. The conformance vectors
pin `transfer` to dispatch tag `79c71c23` and `transfer_delegator` to
`fd3ef14a`.

## How kticket differs

| Aspect | KCC-20 Final | kticket KCC20-fork |
| --- | --- | --- |
| State record | `amount`, `owner`, `owner_scheme`, `borrow_scheme`, `borrow_guard`, `extension_commitment` | `owner`, `identifier_type`, `amount`, `is_minter`, `used`, `sale_price` (declaration order in `contracts/event.sil`) |
| Entrypoints | `transfer` / `transfer_delegator` | `mint`, `use`, `mark_used`, `list`, `purchase`, `delist` |
| Amount | Preserved across the covenant family; all states with the same commitment are fungible | Remaining capacity on the event covenant, always `1` on a ticket. `mint` moves one unit from event to ticket (family total happens to be preserved); the door and resale change non-amount state |
| Owner support | Configurable subset of `0x00`–`0x04`, declared in the artifact | `identifier_type` is always `0x00`; every entrypoint does `checkSig(pubkey(owner))`. No p2pkh, p2sh, or covenant-id owners |
| Borrowing | `borrow_scheme` + `borrow_guard`, four schemes | None. The closest Final setting is `disabled/v1` (`0x00`), but the fields do not exist |
| Extended state | 32-byte `extension_commitment`, opaque to `transfer`, preserved by it | None. `used` and `sale_price` are in-band state fields |
| Program artifact | KCC-1/KCC-20 artifact: state locations, owner schemes, transfer bounds, extended-state digest rule | `kticket/compiled-contract/v2`: bytecode, `state_layout`, template hash, ABI, compiler revisions |
| Dispatch tags | `transfer` `79c71c23`, `transfer_delegator` `fd3ef14a` | Compiler-derived tags for the ticket entrypoints; no byte-level compatibility |

## Why we stay a fork

- **Ticket semantics are the product.** A ticket is not only a balance. The
  door needs `used` (a checked-in ticket must never re-enter, KTK-118), resale
  needs `sale_price` (trustless escrow: pay this to buy, KTK-151), and the
  event covenant needs remaining capacity. KCC-20's standard `transfer`
  treats extended state as opaque and must preserve its commitment, so these
  transitions need covenant-specific entrypoints either way.
- **Conformance is a covenant rewrite, not a rename.** Adopting the Final
  state record changes the state slot and bytecode, so every deployed event
  would stop verifying — the same class of break documented for `mark_used`
  in [`spike-covenant-runtime.md`](spike-covenant-runtime.md) §f. No
  user-facing flow needs it today.
- **Interop does not require it.** KaspaCom's KCC20V2 is also 4-field and
  targets descriptor/metadata compatibility rather than a rewrite
  ([`kaspanet/kccs#11`](https://github.com/kaspanet/kccs/pull/11)), which
  confirms that discovery can be served without full conformance.
- **Historically, the fork came first.** kticket's model comes from forge's
  pre-Final KCC-20 layout (HLD v0.22 §2.1); KCC-20 only became Final on
  2026-08-21. The door and resale fields were added afterwards, moving the
  covenant further from the Final record.

## Interop path

- **Display metadata** — KCC-23 "Metadata JSON": a `0x00` codec byte plus
  UTF-8 JSON in the deploy preparation transaction payload, bound to the
  covenant id (KTK-178).
- **Discovery** — kticket's own descriptor and the
  `kticket/compiled-contract/v2` program artifact tell a reader how to decode
  the state and build each entrypoint. Neither is a KCC-20 program artifact.
- **Positioning** — until a consumer demands `transfer`, kticket is a
  proprietary covenant with standard metadata, not a KCC-20 token.

## Field mapping for a future migration

Not done in KTK-179. This is the mapping a rewrite would implement, checked
against the Final record above.

| kticket (KCC20-fork) | KCC-20 Final | Migration note |
| --- | --- | --- |
| `amount` | `amount` | Same value, but moves from third to first field. Event = remaining capacity; ticket = `1`. |
| `owner` (`byte[32]`) | `owner` (`byte[32]`) | Same x-only pubkey for current events. |
| `identifier_type` (byte, always `0x00`) | `owner_scheme` (byte) | `0x00` → `0x00` (`p2pk-schnorr/v1`). kticket emits no other value; the `0x01`/`0x02` in the TypeScript union are forge legacy and unsupported by the contract. |
| `is_minter` (bool, always `false`) | — | No KCC-20 field. Fixed-supply flag; drop it, or record it in extended state if old events must verify. |
| `used` (byte) | — | Extended state behind `extension_commitment`: include it in the digest so a checked-in ticket stays checked-in. |
| `sale_price` (int) | — | Extended state behind `extension_commitment`: include it in the digest so a listing survives only through the resale entrypoints. |
| — | `borrow_scheme` | `0x00` (`disabled/v1`). kticket has no borrowed receive. |
| — | `borrow_guard` | 32 zero bytes, unused under `disabled/v1`. |
| — | `extension_commitment` | Digest of the extended state (`used`, `sale_price`, role). The digest rule must be declared in the program artifact (KCC-1 §3.9). |
| `mint` / `use` / `mark_used` / `list` / `purchase` / `delist` | `transfer` / `transfer_delegator` plus covenant-specific entrypoints | A conforming `transfer` can cover mint and re-own. The door and resale still need custom entrypoints that interpret extended state; KCC-20 §4 allows a covenant to expose them. |
| `kticket/compiled-contract/v2` (`state_layout` + ABI) | KCC-20 program artifact | Add owner-role field locations, supported owner schemes, borrow schemes (disabled), transfer bounds, and the extended-state digest rule. |

## Follow-up

**Recorded decision:** stay a KCC20-fork; **no follow-up ticket is opened** as
of 2026-10-27.

Revisit if either becomes true:

1. A wallet or explorer we depend on refuses to display or spend kticket
   events without a KCC-20 program artifact.
2. An external covenant needs to compose with tickets through the standard
   `transfer` entrypoint.

If triggered, open a follow-up to rewrite the covenant as KCC-20 with
extended state and re-deploy events. Expect the same
bytecode-invalidates-old-events cost described in §f of
[`spike-covenant-runtime.md`](spike-covenant-runtime.md).
