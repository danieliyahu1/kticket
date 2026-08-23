// Resale sig-script assembly + listing address derivation (KTK-151).
//
// The listing lives in the covenant state (`sale_price`), so a listed ticket's
// P2SH address commits to the asking price — anyone can verify a listing
// against the chain without trusting the API.
//
// Sig-script layouts (same shape as mark_used: args, then `<selector>`, then
// the redeem reveal):
//
//   list      push(65B sig_holder) || push(price i64) || <selector> || push(redeem)
//   delist    push(65B sig_holder)                || <selector> || push(redeem)
//   purchase  push(32B buyer_pkh)                 || <selector> || push(redeem)
//
// `purchase` carries NO signature at all — the covenant is the escrow; the
// authorizing input is simply the buyer's fee UTXO.
//
// The price push must byte-match the compiler's `add_i64` encoding: OP_0 for
// zero, OP_1..OP_16 for small integers, otherwise a minimal little-endian
// data push (trailing zero bytes trimmed, an extra 0x00 appended when the top
// byte would be interpreted as negative).

import type { CompiledContractArtifact } from "../contracts/artifact.js";
import type { AddressNetwork } from "./address.js";
import { addressFor, pushData } from "./address.js";
import { concat } from "./bytes.js";
import { pushSelector } from "./mark-used.js";

/** Length of a Schnorr signature push (64-byte sig + 1-byte sighash type). */
const SIG_PUSH_LENGTH = 65;

/** OP_0 — the minimal-i64 encoding of 0. */
const OP_0 = 0x00;
/** OP_1 — base opcode of the small-integer encodings 1..16. */
const OP_1 = 0x51;

const AUTH_ENTRYPOINTS = {
  list: "__covenant_entrypoint_auth_list",
  purchase: "__covenant_entrypoint_auth_purchase",
  delist: "__covenant_entrypoint_auth_delist",
} as const;

/**
 * A resale auth entrypoint's branch index (selector) within a compiled
 * artifact — its ABI position, exactly what the compiler emits as
 * `function_branch_index` for covenant entrypoints.
 */
export function resaleSelector(artifact: CompiledContractArtifact, entrypoint: keyof typeof AUTH_ENTRYPOINTS): number {
  const index = artifact.abi.findIndex((entry) => entry.name === AUTH_ENTRYPOINTS[entrypoint]);
  if (index < 0) {
    throw new Error(`artifact ${artifact.contract_name} has no ${entrypoint} entrypoint`);
  }
  return index;
}

function assertSig(sig: Uint8Array): void {
  if (sig.length !== SIG_PUSH_LENGTH) {
    throw new Error(`signature must be ${SIG_PUSH_LENGTH} bytes, got ${sig.length}`);
  }
}

/**
 * Encode a non-negative safe integer exactly like rusty-kaspa's
 * `ScriptBuilder::add_i64`: OP_0 / OP_1..OP_16 fast paths, else a data push of
 * the minimal little-endian magnitude (with a trailing 0x00 when the highest
 * byte has its sign bit set).
 */
export function pushI64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`value ${value} is not a non-negative safe integer`);
  }
  if (value === 0) {
    return Uint8Array.of(OP_0);
  }
  if (value <= 16) {
    return Uint8Array.of(OP_1 - 1 + value);
  }
  const digits: number[] = [];
  let rest = BigInt(value);
  let saturated = false;
  while (rest > 0n || saturated) {
    if (rest === 0n) {
      digits.push(0);
      saturated = false;
      break;
    }
    const digit = Number(rest & 0xffn);
    saturated = (digit & 0x80) !== 0;
    digits.push(digit);
    rest >>= 8n;
  }
  return pushData(Uint8Array.from(digits));
}

/**
 * Assemble the ticket input's sig-script for a `list` spend:
 * `push(65B sig_holder) || push(price) || <selector> || push(redeem)`.
 */
export function assembleListSigScript(
  artifact: CompiledContractArtifact,
  sigHolder: Uint8Array,
  price: number,
  redeem: Uint8Array,
): Uint8Array {
  assertSig(sigHolder);
  return concat([pushData(sigHolder), pushI64(price), pushSelector(resaleSelector(artifact, "list")), pushData(redeem)]);
}

/**
 * Assemble the ticket input's sig-script for a `delist` spend:
 * `push(65B sig_holder) || <selector> || push(redeem)`.
 */
export function assembleDelistSigScript(
  artifact: CompiledContractArtifact,
  sigHolder: Uint8Array,
  redeem: Uint8Array,
): Uint8Array {
  assertSig(sigHolder);
  return concat([pushData(sigHolder), pushSelector(resaleSelector(artifact, "delist")), pushData(redeem)]);
}

/**
 * Assemble the ticket input's sig-script for a trustless `purchase` spend:
 * `push(32B buyer_pkh) || <selector> || push(redeem)` — no seller signature,
 * no buyer signature; the covenant enforces payment + delivery.
 */
export function assemblePurchaseSigScript(
  artifact: CompiledContractArtifact,
  buyerPkh: Uint8Array,
  redeem: Uint8Array,
): Uint8Array {
  if (buyerPkh.length !== 32) {
    throw new Error(`buyer_pkh must be 32 bytes, got ${buyerPkh.length}`);
  }
  return concat([pushData(buyerPkh), pushSelector(resaleSelector(artifact, "purchase")), pushData(redeem)]);
}

/**
 * The P2SH address of a listed ticket state — the reader's "is this ticket
 * really listed at this price?" check. Compare the live coin's address against
 * the derived one; only a match proves the on-chain asking price.
 */
export function listedStateAddress(
  artifact: CompiledContractArtifact,
  owner: Uint8Array,
  salePrice: number,
  network: AddressNetwork,
): string {
  return addressFor(
    artifact,
    { owner, identifierType: 0, amount: 1, isMinter: false, used: false, salePrice },
    network,
  );
}
