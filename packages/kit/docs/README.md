# @kticket/kit docs

Design notes and decision records for the covenant kit. The code is the source
of truth for behavior; these notes explain why it is shaped this way.

## Decision records

| Note | Decision | Status |
| --- | --- | --- |
| [`spike-covenant-runtime.md`](decisions/spike-covenant-runtime.md) | Covenant runtime: KIP-20 family ids, compiler/ABI layout, the tx-builder boundary, and the `mark_used` door transition. | Accepted |
| [`kcc20-fork.md`](decisions/kcc20-fork.md) | kticket's covenant stays a **KCC20-fork** and does not claim KCC-20 Final conformance. Records the state/entrypoint differences and the field mapping for a future migration. | Accepted (KTK-179) |

## Related

- [`contracts/event.sil`](../contracts/event.sil) — the event covenant (state
  layout and entrypoints).
- [`src/contracts/types.ts`](../src/contracts/types.ts) — TypeScript view of
  the fork.
- [`README.md`](../../../README.md) — product and operations contract.
