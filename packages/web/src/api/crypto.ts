import { organizerAddressFromPubkeyHex } from "@kticket/kit";
import type { AddressNetwork } from "@kticket/kit";

const COMPRESSED_PUBKEY_LEN = 66;
const COMPRESSED_PREFIX_HEX_CHARS = 2;
const OP_PUSH_32 = "20";
const OP_CHECKSIG = "ac";
const X_COORD_HEX_LEN = 64;

/**
 * The 32-byte covenant owner identifier for an organizer: the x-coordinate of
 * the compressed public key (the `03`/`02` prefix dropped). Kaspa P2PK UTXOs
 * lock to exactly this 32-byte value (`20 <x> ac`), so the event covenant's
 * owner matches the organizer's on-chain key.
 */
export function organizerPkh(publicKeyHex: string): string {
  const key = publicKeyHex.toLowerCase();
  if (key.length === COMPRESSED_PUBKEY_LEN) {
    return key.slice(COMPRESSED_PREFIX_HEX_CHARS);
  }
  return key;
}

/**
 * The organizer's bech32 P2PK address (the trust anchor the API reports as
 * `organizer_address`). Derived from the 32-byte pubkey x-coordinate — the same
 * value the funding UTXO locks to, so a user can eyeball-match it against the
 * artist's known address out-of-band.
 */
export function organizerAddressFromPublicKey(
  publicKeyHex: string,
  network: AddressNetwork = "testnet10",
): string {
  return organizerAddressFromPubkeyHex(organizerPkh(publicKeyHex), network);
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
