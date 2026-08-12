// Door check-in flow (POST /v1/tickets/{ticket_id}/use/prepare) — the owner
// side of the door (parent KTK-118, sub-issue KTK-123; HLD v7 FR-5).
//
//   prepare — backend verifies the ticket is the event's ticket (covenant
//             family -> registry -> deploy -> verifyEventFromChain), that it is
//             owned by the caller and unused (amount == 1, used == false), then
//             builds the fixed mark_used template the owner pre-signs:
//               inputs  [ticket, owner fee UTXOs]
//               outputs [ticket at used:true, owner change]
//             Returns `{use_id, template, signing_template, sign_inputs_owner,
//             event}`. The `use_id` is a correlation id; a fresh prepare
//             invalidates any earlier QR (re-sign path).
//
// The owner's signature on the ticket input is produced offline (wallet); the
// gate later re-derives the signing template and co-signs (KTK-128/129, parent
// KTK-119). Nothing is spent here — the template is only pre-signed.

import { randomUUID } from "node:crypto";
import {
  addressFor,
  addressFromScriptHash,
  organizerPkh,
  orgSpkFromPublicKey,
  type KaspaNetwork,
} from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import { invalidError, notFoundError, policyError } from "./errors.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { UtxoResponse } from "./kaspa-types.js";
import { verifyEventFromChain } from "./provenance.js";
import { buildTransaction } from "./tx.js";
import { isRecord, str } from "./validate.js";
import type { WireTransaction, WireUtxo, WireUtxoMeta } from "./wire.js";

export interface UseContext {
  kaspa: KaspaClientLike;
  networkId: string;
  network: KaspaNetwork;
  /** Resolve the registry pointer for a covenant id (may be undefined). */
  byCovenantId: (covenantId: string) => { deployTxId: string } | undefined;
}

export interface UsePrepareRequest {
  /** Compressed (66-hex) or bare x-coordinate (64-hex) owner public key. */
  publicKey: string;
  /** The owner's bech32 address — the backend fetches its fee UTXOs itself. */
  address: string;
}

export interface UsePrepareResult {
  /** Correlation id the client stores in the QR — a fresh prepare invalidates it. */
  use_id: string;
  signing_template: string;
  /** The unsigned mark_used template the owner pre-signs. */
  template: WireTransaction;
  /** Inputs the owner must sign: the ticket (index 0) + fee UTXOs (1..). */
  sign_inputs_owner: { index: number }[];
  /** Verified event facts for the wallet dialog "Hand over your ticket to [event]?". */
  event: { name: string; date: string };
}

const COMPRESSED_PUBKEY_HEX_LEN = 66;
const X_COORD_HEX_LEN = 64;
const PUBKEY_HEX = /^[0-9a-fA-F]+$/;
const TICKET_ID = /^([0-9a-fA-F]{64}):(\d+)$/;

function validatePublicKey(publicKey: unknown, label = "publicKey"): string {
  const key = str(publicKey, label).toLowerCase();
  if (!PUBKEY_HEX.test(key)) throw invalidError(`${label} must be hex`);
  if (key.length !== COMPRESSED_PUBKEY_HEX_LEN && key.length !== X_COORD_HEX_LEN) {
    throw invalidError(`${label} must be 66 or 64 hex chars`);
  }
  return key;
}

/** Parse `<txid>:<index>` — the ticket_id shape served by GET /v1/tickets. */
function parseTicketId(value: unknown): { txid: string; index: number } {
  const s = str(value, "ticket_id");
  const match = TICKET_ID.exec(s);
  if (!match) throw invalidError("ticket_id must be <64-hex-txid>:<output-index>");
  return { txid: match[1]!.toLowerCase(), index: Number(match[2]) };
}

function toWireUtxo(u: UtxoResponse): WireUtxo {
  return {
    transaction_id: u.outpoint.transactionId,
    index: u.outpoint.index,
    value: Number(u.utxoEntry.amount),
  };
}

function toWireUtxoMeta(u: UtxoResponse): WireUtxoMeta {
  return {
    transaction_id: u.outpoint.transactionId,
    index: u.outpoint.index,
    value: Number(u.utxoEntry.amount),
    script_public_key: { version: 0, script: u.utxoEntry.scriptPublicKey.scriptPublicKey },
    block_daa_score: Number(u.utxoEntry.blockDaaScore),
    is_coinbase: u.utxoEntry.isCoinbase,
    ...(typeof u.address === "string" ? { address: u.address } : {}),
  };
}

function parsePrepare(raw: unknown): UsePrepareRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  return {
    publicKey: validatePublicKey(raw.publicKey),
    address: str(raw.address, "address"),
  };
}

/**
 * The ticket's on-chain P2SH script is the standard `aa20 <hash> 87` form;
 * derive its address so it can be compared to the caller's derived ticket
 * address (ownership check).
 */
function ticketAddressOf(script: string | undefined, network: KaspaNetwork): string {
  if (!script) throw invalidError("ticket output has no script public key");
  return addressFromScriptHash(script, network);
}

/**
 * prepare: verify the ticket is the event's ticket, owned by the caller and
 * unused, then build the fixed mark_used template the owner pre-signs.
 */
export async function usePrepare(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: UseContext,
): Promise<UsePrepareResult> {
  const req = parsePrepare(raw);
  const { txid, index } = parseTicketId(ticketIdValue);

  // 1. Fetch the ticket output — the minted ticket covenant carrying the event
  //    family id. Missing output -> the ticket does not exist.
  const ticketTx = await ctx.kaspa.getTransaction(txid);
  const ticketOutput = ticketTx?.outputs[index];
  if (!ticketOutput) throw notFoundError(`ticket ${txid}:${index} not found on chain`);

  const covenantId = ticketOutput.covenant_id;
  if (!covenantId) {
    throw invalidError(`output ${txid}:${index} is not a covenant ticket`);
  }

  // 2. Resolve the event from the ticket's covenant family via the registry,
  //    then verify the event from the chain (stateless trust anchor).
  const entry = ctx.byCovenantId(covenantId);
  if (!entry) throw notFoundError(`event for ticket ${txid}:${index} not found`);
  const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
  if (verified.covenant_id !== covenantId) {
    throw invalidError("ticket does not belong to the verified event");
  }

  // 3. Ownership + unused check: the ticket address derives from the owner's
  //    key at amount 1 / used false. If the caller's key reproduces the ticket's
  //    on-chain address, the ticket is theirs and unused (FR-9/FR-28).
  const ownerPkh = organizerPkh(req.publicKey);
  const ownerBytes = hexToBytes(ownerPkh);
  const ownerAddress = addressFor(
    verified.artifact,
    { owner: ownerBytes, identifierType: 0, amount: 1, isMinter: false, used: false },
    ctx.network,
  );
  const ticketAddress = ticketAddressOf(ticketOutput.script_public_key, ctx.network);
  if (ownerAddress !== ticketAddress) {
    throw policyError("you have no ticket for this event");
  }

  // 4. The owner pays the fee: fetch their UTXOs.
  const ownerUtxos = (await ctx.kaspa.getUtxos(req.address))
    .filter((u) => u.outpoint && u.utxoEntry)
    .sort((a, b) => Number(b.utxoEntry.amount) - Number(a.utxoEntry.amount));
  if (ownerUtxos.length === 0) {
    throw policyError("no spendable UTXOs on the owner address");
  }

  // 5. Build the fixed mark_used template: inputs [ticket, owner fee UTXOs],
  //    outputs [ticket at used:true, owner change].
  const result = await buildTransaction(
    {
      type: "markUsed",
      ticket_outpoint: { transaction_id: txid, index },
      event_covenant_id: verified.covenant_id,
      owner: ownerPkh,
      owner_utxos: ownerUtxos.map(toWireUtxo),
      change_spk: { version: 0, script: orgSpkFromPublicKey(req.publicKey) },
      constants: {
        authorizing_txid: verified.authorizing_txid,
        price: verified.price,
        org_spk: verified.org_spk,
        burn_template_hash: verified.burn_template_hash,
      },
      input_utxo_metas: ownerUtxos.map(toWireUtxoMeta),
    },
    { kaspa: ctx.kaspa, networkId: ctx.networkId },
  );

  if (!result.signing_template) {
    throw invalidError("could not build a signing template for the check-in");
  }

  return {
    use_id: randomUUID(),
    signing_template: result.signing_template,
    template: result.template,
    // The owner signs the ticket input (index 0) + their fee UTXOs (1..).
    sign_inputs_owner: result.template.inputs.map((_, i) => ({ index: i })),
    event: { name: verified.name, date: verified.date },
  };
}
