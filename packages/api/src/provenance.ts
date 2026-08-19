// Chain-verified event provenance (KTK-89) — the stateless backend's trust
// anchor. Every event read re-derives the event's fields from the chain and
// verifies them before serving:
//
//   1. fetch the deploy tx by its id
//   2. decode the KCC-0021 payload → name / date / price-label
//   3. recover the constants from on-chain facts (authorizing outpoint, funding
//      UTXO owner pubkey, derived burn template hash)
//   4. maker check: the deploy input-0 previous UTXO (the organizer's funding
//      output) must be a P2PK script whose pubkey is the covenant owner — i.e.
//      the event was deployed by the address that owns the covenant
//   5. address commitment check: the deploy covenant output script must equal
//      `P2SH(blake3(redeem))` reconstructed from the recovered constants + state
//      (this simultaneously recovers capacity by scanning candidate amounts)
//   6. availability is then computed by the lineage walk (unchanged)
//
// The registry stores only identifiers for discovery; nothing here trusts it.

import {
  type CompiledContractArtifact,
  type KaspaNetwork,
  eventOutputScript,
  p2pkAddress,
  pubkeyFromP2pkScript,
  recoverEventCapacity,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decodeMetadataFromPayload } from "@kticket/kit";
import { covenantId } from "@kticket/kit";
import { burnTemplateHashOf, compileEventArtifact } from "./compiler.js";
import { invalidError } from "./errors.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { P2SH_SCRIPT } from "./validate.js";

export interface RawChainFacts {
  deploy_txid: string;
  authorizing_txid: string;
  maker_address: string;
  decoded_constants: {
    price: number;
    org_spk: string;
    burn_template_hash: string;
  };
  decoded_state: {
    owner: string;
    capacity: number;
  };
  payload: string | null;
}

export interface VerifiedEvent {
  deploy_txid: string;
  covenant_id: string;
  name: string;
  date: string;
  /** Local wall-clock start time (HH:MM), decoded from the payload; "" when absent. */
  time: string;
  /** KCC-0021 short ticker (read alias `symbol`), decoded from the payload. */
  ticker: string;
  /** KCC-0021 display decimals (default 0). */
  decimals: number;
  /** KCC-0021 poster art URI (https:// or ipfs://), "" when absent. */
  image: string;
  /** KCC-0021 sha256 image hash (lowercase hex), "" when absent. */
  image_hash: string;
  /** Price per ticket in sompi — recovered from covenant constants (verified). */
  price: number;
  capacity: number;
  /** The trust-anchor address the event provably belongs to. */
  organizer_address: string;
  /** 32-byte covenant owner pubkey (x-coordinate), hex. */
  owner_pkh: string;
  org_spk: string;
  burn_template_hash: string;
  authorizing_txid: string;
  raw_chain: RawChainFacts;
  /** The per-event compiled artifact, reused by the availability walk. */
  artifact: CompiledContractArtifact;
}

const U64_MAX = Number.MAX_SAFE_INTEGER;

function hexOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function decodePriceLabel(priceKAS: unknown): number {
  const n = Number(priceKAS);
  if (!Number.isFinite(n) || n < 0 || n * 100_000_000 > U64_MAX) return 0;
  return Math.round(n * 100_000_000);
}

/**
 * Verify an event purely from its deploy transaction on chain.
 * Throws `invalidError` when the deploy tx is not a verifiable kticket event
 * (missing on chain, bad payload, funding UTXO not P2PK, or the address
 * commitment does not reproduce the deploy output).
 */
export async function verifyEventFromChain(
  kaspa: KaspaClientLike,
  network: KaspaNetwork,
  deployTxId: string,
): Promise<VerifiedEvent> {
  const deploy = await kaspa.getTransaction(deployTxId);
  if (!deploy) {
    throw invalidError(`deploy transaction ${deployTxId} not found on chain`);
  }

  const covenantOutput = deploy.outputs?.[0];
  const onChainScript = covenantOutput?.script_public_key;
  if (typeof onChainScript !== "string" || !P2SH_SCRIPT.test(onChainScript)) {
    throw invalidError(`deploy transaction ${deployTxId} has no covenant output`);
  }

  const authorizingInput = deploy.inputs?.[0];
  if (!authorizingInput) {
    throw invalidError(`deploy transaction ${deployTxId} has no inputs`);
  }
  const authorizingTxId = hexOrEmpty(authorizingInput.previous_outpoint_hash);
  if (!/^[0-9a-f]{64}$/.test(authorizingTxId)) {
    throw invalidError("deploy input-0 has no previous outpoint");
  }
  const fundingIndex = Number(authorizingInput.previous_outpoint_index ?? 0);

  // Maker check (HLD §2.2 step 4): the deploy input-0 previous UTXO is the
  // organizer's funding output. Its script must be P2PK `20 <x> ac`, and the
  // pubkey x is the covenant owner. Derive the trust-anchor address from it.
  const funding = await kaspa.getTransaction(authorizingTxId);
  const fundingScript = funding?.outputs?.[fundingIndex]?.script_public_key;
  if (typeof fundingScript !== "string") {
    throw invalidError("could not resolve the deploy authorizing UTXO");
  }
  const ownerPubkey = pubkeyFromP2pkScript(fundingScript);
  if (!ownerPubkey) {
    throw invalidError("deploy authorizing UTXO is not a P2PK output");
  }
  const organizerAddress = p2pkAddress(ownerPubkey, network);

  // Decode KCC-0021 payload → name / date / time / standard keys / price-label.
  const meta = decodeMetadataFromPayload(deploy.payload);
  const name = meta?.name ?? "";
  const date = meta?.date ?? "";
  const time = meta?.time ?? "";
  const ticker = meta?.ticker ?? "";
  const decimals = meta?.decimals ?? 0;
  const image = meta?.image ?? "";
  const imageHash = meta?.image_hash ?? "";
  const price = meta ? decodePriceLabel(meta.priceKAS) : 0;
  const orgSpk = (meta?.orgSpk || fundingScript).toLowerCase();
  // The burn template hash is derived at compile time (authorizing_txid baked),
  // so the API is authoritative — the payload value is advisory.
  const burnTemplateHash = burnTemplateHashOf(authorizingTxId).toLowerCase();

  // Recompile the per-event artifact from the recovered constants.
  const artifact = compileEventArtifact({
    authorizingTxId,
    price,
    orgSpk,
    burnTemplateHash,
  });

  // Address commitment check (HLD §2.2 step 5): scanning candidate capacities
  // recovers the deployed `remaining` AND proves the constants/state reproduce
  // the on-chain covenant output.
  const capacity = recoverEventCapacity(artifact, ownerPubkey, onChainScript);
  if (capacity === null) {
    throw invalidError(`event ${deployTxId} fails on-chain verification`);
  }

  const covenantIdHex = bytesToHex(
    covenantId(
      { txId: hexToBytes(authorizingTxId), index: fundingIndex },
      [
        {
          index: 0,
          value: covenantOutput?.amount ?? 0,
          version: 0,
          script: hexToBytes(onChainScript),
        },
      ],
    ),
  );

  return {
    deploy_txid: deployTxId.toLowerCase(),
    covenant_id: covenantIdHex,
    name,
    date,
    time,
    ticker,
    decimals,
    image,
    image_hash: imageHash,
    price,
    capacity,
    organizer_address: organizerAddress,
    owner_pkh: bytesToHex(ownerPubkey),
    org_spk: orgSpk,
    burn_template_hash: burnTemplateHash,
    authorizing_txid: authorizingTxId,
    raw_chain: {
      deploy_txid: deployTxId.toLowerCase(),
      authorizing_txid: authorizingTxId,
      maker_address: organizerAddress,
      decoded_constants: { price, org_spk: orgSpk, burn_template_hash: burnTemplateHash },
      decoded_state: { owner: bytesToHex(ownerPubkey), capacity },
      payload: deploy.payload ?? null,
    },
    artifact,
  };
}

/** Reconstruct the event covenant output script for a `remaining` value. */
export function eventScriptFor(
  artifact: CompiledContractArtifact,
  ownerPkhHex: string,
  remaining: number,
): string {
  return eventOutputScript(artifact, {
    owner: hexToBytes(ownerPkhHex),
    amount: remaining,
  });
}
