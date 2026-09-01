// mark_used sig-script assembly + used-state address derivation (KTK-127,
// parent KTK-119 — the gate's co-signing leg of the door flow).
//
// The owner pre-signs the ticket input offline; the gate co-signs the same
// input at the door. The node's covenant VM runs the Event contract's
// `mark_used` transition on that input and requires BOTH Schnorr signatures:
//
//   push(65B sig_owner) || push(65B sig_gate) || push(dispatch_tag) || push(redeem)
//
// where `dispatch_tag` identifies the auth entrypoint (as with
// mint/list/purchase/delist) and `push(redeem)` reveals the full redeem script (the
// artifact bytecode with the ticket's live state injected) so the P2SH spend
// can be validated.
//
// This module is pure assembly shared by the API (finalize) and the web gate:
// it does not sign (keys stay in the wallets) and does not compile (the API
// runs the kticket-silverc toolchain). The dispatch tag comes from the compiled
// artifact's ABI, so the emitted script is byte-exact without a
// compiler.

import type { CompiledContractArtifact } from "../contracts/artifact.js";
import type { AddressNetwork } from "./address.js";
import { addressFor, pushData } from "./address.js";
import { concat } from "./bytes.js";

/** Length of a Schnorr signature push (64-byte sig + 1-byte sighash type). */
export const SIG_PUSH_LENGTH = 65;

/** The compiler's auth entrypoint name for the mark_used covenant declaration. */
const MARK_USED_AUTH_ENTRYPOINT = "__covenant_entrypoint_auth_mark_used";

/** The mark_used auth entrypoint's canonical four-byte dispatch tag. */
export function markUsedDispatchTag(artifact: CompiledContractArtifact): Uint8Array {
  const entry = artifact.abi.find((candidate) => candidate.name === MARK_USED_AUTH_ENTRYPOINT);
  if (!entry) {
    throw new Error(`artifact ${artifact.contract_name} has no mark_used entrypoint`);
  }
  return dispatchTagBytes(entry.dispatch_tag);
}

export function dispatchTagBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{8}$/.test(hex)) {
    throw new Error(`invalid dispatch tag ${hex}`);
  }
  const bytes = new Uint8Array(4);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function assertSig(sig: Uint8Array, label: string): void {
  if (sig.length !== SIG_PUSH_LENGTH) {
    throw new Error(`${label} must be ${SIG_PUSH_LENGTH} bytes, got ${sig.length}`);
  }
}

/**
 * Assemble the ticket input's sig-script for the mark_used spend:
 * `push(65B sig_owner) || push(65B sig_gate) || push(dispatch_tag) || push(redeem)`.
 *
 * `sigOwner` / `sigGate` are the raw 65-byte wallet signature pushes (signature
 * + SIGHASH_ALL byte) for input 0; `redeem` is the ticket's full redeem script
 * (artifact bytecode with the live `{owner, amount: 1, used: false}` state
 * injected). Throws when either signature is not exactly 65 bytes or when both
 * are not present — the node's two `checkSig` calls would reject any shorter or
 * missing push.
 */
export function assembleMarkUsedSigScript(
  artifact: CompiledContractArtifact,
  sigOwner: Uint8Array,
  sigGate: Uint8Array,
  redeem: Uint8Array,
): Uint8Array {
  assertSig(sigOwner, "sig_owner");
  assertSig(sigGate, "sig_gate");
  return concat([
    pushData(sigOwner),
    pushData(sigGate),
    pushData(markUsedDispatchTag(artifact)),
    pushData(redeem),
  ]);
}

/**
 * The P2SH address of a ticket covenant output for a given used state — the
 * reader's "is this ticket used?" tool. Compare the live coin's address against
 * the `used: false` (valid) and `used: true` (entered) addresses to classify a
 * ticket at the door.
 */
export function usedStateAddress(
  artifact: CompiledContractArtifact,
  owner: Uint8Array,
  used: boolean,
  network: AddressNetwork,
): string {
  return addressFor(
    artifact,
    { owner, identifierType: 0, amount: 1, isMinter: false, used, salePrice: 0 },
    network,
  );
}
