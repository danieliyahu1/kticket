// Provenance helpers (KTK-89) — verify that an event's displayed data is
// authentic and provably belongs to a known organizer address, purely from
// on-chain data with no trust in the kticket backend.
//
// The chain stores only `P2SH(blake3(redeem_script))` for a covenant output —
// never the redeem script itself. So verification is *reconstruction*: recompile
// the per-event artifact from chain-derived facts (authorizing outpoint, funding
// UTXO owner, KCC-0021 payload) and check that the reconstructed P2SH commitment
// equals the deploy output script on chain. If it matches, the constants (price,
// org_spk, burn_template_hash) and state (owner, capacity) that produced it are
// the ones the organizer actually deployed.

import { hexToBytes } from "@noble/hashes/utils.js";
import type { CompiledContractArtifact } from "../contracts/artifact.js";
import { injectState, p2pkAddress } from "./address.js";
import { MAX_EVENT_CAPACITY, p2shScript } from "./builder.js";
import type { AddressNetwork } from "./address.js";

export interface EventState {
  /** 32-byte covenant owner identifier (the organizer pubkey x-coordinate). */
  owner: Uint8Array;
  /** Remaining tickets (`amount`) on the event covenant. */
  amount: number;
}

/**
 * The organizer's bech32 P2PK address from a 32-byte pubkey hex x-coordinate —
 * the trust anchor for an event (what the API reports as `organizer_address`).
 */
export function organizerAddressFromPubkeyHex(
  pubkeyHex: string,
  network: AddressNetwork = "testnet10",
): string {
  return p2pkAddress(hexToBytes(pubkeyHex), network);
}

const COMPRESSED_PUBKEY_LEN = 66;
const COMPRESSED_PREFIX_HEX_CHARS = 2;
const OP_PUSH_32 = "20";
const OP_CHECKSIG = "ac";
const X_COORD_HEX_LEN = 64;

/**
 * The 32-byte covenant owner identifier for an organizer: the x-coordinate of
 * the compressed public key (the `03`/`02` prefix dropped). Kaspa P2PK UTXOs
 * lock to exactly this 32-byte value (`20 <x> ac`).
 */
export function organizerPkh(publicKeyHex: string): string {
  const key = publicKeyHex.toLowerCase();
  if (key.length === COMPRESSED_PUBKEY_LEN) {
    return key.slice(COMPRESSED_PREFIX_HEX_CHARS);
  }
  return key;
}

/**
 * The organizer's payout script (`org_spk`): a P2PK script locking to the
 * 32-byte x-coordinate — `OP_PUSH32 <x> OP_CHECKSIG`. This is the script the
 * buy path pays ticket proceeds into.
 */
export function orgSpkFromPublicKey(publicKeyHex: string): string {
  const x = organizerPkh(publicKeyHex);
  if (x.length !== X_COORD_HEX_LEN) {
    throw new Error(`public key x-coordinate must be 64 hex chars, got ${x.length}`);
  }
  return `${OP_PUSH_32}${x}${OP_CHECKSIG}`;
}

/**
 * The full P2SH output script a covenant output with `state` would have on
 * chain (`aa20 <blake3(redeem)> 87`) — what the deploy output must equal.
 */
export function eventOutputScript(artifact: CompiledContractArtifact, state: EventState): string {
  const redeem = injectState(artifact, {
    owner: state.owner,
    identifierType: 0,
    amount: state.amount,
    isMinter: false,
    used: false,
  });
  return p2shScript(redeem).script;
}

/**
 * The address commitment check (HLD §2.2 step 5): does the on-chain deploy
 * output script equal the P2SH commitment of the artifact compiled from the
 * given state? A match proves the constants + state reproduce the bytecode the
 * organizer actually committed to.
 */
export function eventCommitmentMatches(
  artifact: CompiledContractArtifact,
  state: EventState,
  onChainScript: string,
): boolean {
  return eventOutputScript(artifact, state).toLowerCase() === onChainScript.toLowerCase();
}

/**
 * Recover the event covenant's initial `remaining` (capacity) by scanning every
 * candidate amount and checking the address commitment. The deploy covenant
 * output commits to `amount = capacity`, so the matching amount is the verified
 * capacity. Returns `null` when no amount reproduces the on-chain script.
 */
export function recoverEventCapacity(
  artifact: CompiledContractArtifact,
  owner: Uint8Array,
  onChainScript: string,
  max = MAX_EVENT_CAPACITY,
): number | null {
  for (let amount = 0; amount <= max; amount++) {
    if (eventCommitmentMatches(artifact, { owner, amount }, onChainScript)) {
      return amount;
    }
  }
  return null;
}
