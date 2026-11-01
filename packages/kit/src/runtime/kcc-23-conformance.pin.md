# KCC-23 conformance vector — provenance pin

`kcc-23-conformance.json` is vendored **byte-for-byte** from kaspanet/kccs. Do not
edit it; refresh it instead.

| Field | Value |
| --- | --- |
| Source | https://github.com/kaspanet/kccs/blob/1ed87aef59faff8354061aee30f734a3b8b2c3d2/kcc-0023/vectors/conformance.json |
| kaspanet/kccs commit | `1ed87aef59faff8354061aee30f734a3b8b2c3d2` |
| KCC-23 status at that commit | `Draft` |
| Spec | https://github.com/kaspanet/kccs/blob/1ed87aef59faff8354061aee30f734a3b8b2c3d2/kcc-0023.md |
| Hashing reference (in the vector) | kaspanet/rusty-kaspa `cfafeb4c093fa37a303f1b9f19c58f986b870ce3` |
| Vendored on | 2026-11-02 |

## Which digest each pin governs

The ids depend on two upstream documents, so both commits are pinned:

- the **vector** (kaspanet/kccs) fixes the fixture's bytes and expected values;
- the **hashing reference** (rusty-kaspa) fixes the domain tags and preimage
  layout that produce them.

## Refresh rule

KCC-23 is `Draft` and may change. kticket implements the current text on
kaspanet/kccs `main`.

When the spec or the vector changes:

1. Replace `kcc-23-conformance.json` with the new file, unchanged.
2. Update every row in the table above in the same commit.
3. Fix whatever `kcc-23-conformance.test.ts` (kit) and the matching case in
   `packages/api/src/wrpc-client.test.ts` now reject, in the same commit.
