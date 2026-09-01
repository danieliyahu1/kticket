// Gate endpoints (KTK-128/129, parent KTK-119) — the organizer's side of the
// door flow. The gate never holds state: it relays the owner's pre-signed
// template, re-derives the signing template, co-signs input 0, and broadcasts
// the blockDAG's verdict.
//
//   POST /v1/tickets/{ticket_id}/use/sign-template — stateless re-derive
//     (Option B): given the owner's template, re-fetch each input's prev-output
//     chain facts (script, amount, daa, covenant_id) and rebuild the identical
//     kaspa-wasm safe-JSON the wallet signs. Byte-exact — the owner's signature
//     is over this template, so any divergence rejects the spend.
//
//   POST /v1/tickets/{ticket_id}/use/finalize — merge the owner's and the
//     gate's raw signatures, assemble input 0's mark_used sig-script
//     (push(owner_sig) || push(gate_sig) || push(dispatch_tag) || push(redeem)), relay,
//     and return {txid} or the node's rejection verbatim.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  assembleMarkUsedSigScript,
  injectState,
  p2shScript,
  pubkeyFromP2pkScript,
  type KaspaNetwork,
} from "@kticket/kit";
import { invalidError, notFoundError, policyError } from "./errors.js";
import type { ListingStore } from "./listings.js";
import { broadcastAndConfirm } from "./flow.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { verifyEventFromChain, type VerifiedEvent } from "./provenance.js";
import { signingTemplateFor } from "./tx.js";
import { isRecord, str } from "./validate.js";
import type { WireTransaction, WireUtxoMeta } from "./wire.js";

export interface UseGateContext {
  kaspa: KaspaClientLike;
  networkId: string;
  network: KaspaNetwork;
  /** Resolve the registry pointer for a covenant id (may be undefined). */
  byCovenantId: (covenantId: string) => { deployTxId: string } | undefined;
  /** Listings index — proposes the asking price for a listed check-in. */
  listings: ListingStore;
}

export interface UseSignTemplateResult {
  signing_template: string;
}

export interface UseFinalizeResult {
  txid: string;
}

const TICKET_ID = /^([0-9a-fA-F]{64}):(\d+)$/;
const P2PK_SCRIPT = /^20[0-9a-fA-F]{64}ac$/;
/** A wallet signature push for input 0: OP_PUSHDATA(65) || 65 bytes. */
const SIG_PUSH_LENGTH = 65;

function parseTicketId(value: unknown): { txid: string; index: number } {
  const s = str(value, "ticket_id");
  const match = TICKET_ID.exec(s);
  if (!match) throw invalidError("ticket_id must be <64-hex-txid>:<output-index>");
  return { txid: match[1]!.toLowerCase(), index: Number(match[2]) };
}

function parseTemplate(raw: unknown): WireTransaction {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const template = raw.template;
  if (!isRecord(template)) throw invalidError("template must be an object");
  if (!Array.isArray(template.inputs) || template.inputs.length === 0) {
    throw invalidError("template must have inputs");
  }
  if (!Array.isArray(template.outputs) || template.outputs.length === 0) {
    throw invalidError("template must have outputs");
  }
  return template as unknown as WireTransaction;
}

function parseFinalize(raw: unknown): {
  use_id: string;
  template: WireTransaction;
  owner_signed: unknown;
  gate_signed: unknown;
} {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const template = parseTemplate(raw);
  if (typeof raw.owner_signed !== "string" && typeof raw.owner_signed !== "object") {
    throw invalidError("owner_signed must be the owner's signing output");
  }
  if (typeof raw.gate_signed !== "string" && typeof raw.gate_signed !== "object") {
    throw invalidError("gate_signed must be the gate's signing output");
  }
  return {
    use_id: str(raw.use_id, "use_id"),
    template,
    owner_signed: raw.owner_signed,
    gate_signed: raw.gate_signed,
  };
}

/** The ticket output's prev-output covenant id (the ticket's family id). */
function ticketCovenantId(template: WireTransaction): string {
  const covenant = template.outputs[0]?.covenant;
  if (!covenant) throw invalidError("template is not a mark_used spend (no covenant output)");
  return covenant.covenant_id.toLowerCase();
}

/**
 * Re-fetch each input's prev-output chain facts and build the utxo metas the
 * signing template needs. The owner's template carries only outpoints — the
 * wallet signs against the prev-output script / amount / daa / covenant id, so
 * the gate rebuilds them from the chain (stateless, byte-exact).
 */
async function rederiveInputMetas(
  kaspa: KaspaClientLike,
  template: WireTransaction,
): Promise<WireUtxoMeta[]> {
  return Promise.all(
    template.inputs.map(async (input) => {
      const tx = await kaspa.getTransaction(input.previous_outpoint.transaction_id);
      const output = tx?.outputs?.[input.previous_outpoint.index];
      if (!output) {
        throw notFoundError(
          `prev output ${input.previous_outpoint.transaction_id}:${input.previous_outpoint.index} not found on chain`,
        );
      }
      return {
        transaction_id: input.previous_outpoint.transaction_id,
        index: input.previous_outpoint.index,
        value: output.amount,
        script_public_key: {
          version: 0,
          script: output.script_public_key ?? "",
        },
        block_daa_score: tx?.accepting_block_blue_score ?? 0,
        is_coinbase: false,
        ...(output.covenant_id ? { covenant_id: output.covenant_id } : {}),
      } satisfies WireUtxoMeta;
    }),
  );
}

/**
 * sign-template (KTK-128): rebuild the identical safe-JSON signing template
 * from the template's prev-output chain facts. Pure function over chain facts —
 * no pending state; the gate's co-signature must be over the same template the
 * owner signed.
 */
export async function useSignTemplate(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: UseGateContext,
): Promise<UseSignTemplateResult> {
  parseTicketId(ticketIdValue);
  const template = parseTemplate(raw);
  const metas = await rederiveInputMetas(ctx.kaspa, template);
  const signing_template = await signingTemplateFor(template, metas);
  return { signing_template };
}

/**
 * The ticket owner's 32-byte pubkey, recovered from the template's change
 * output (a P2PK script `20 <x> ac` — the owner's change returns to their own
 * address, so the script carries the owner identity).
 */
function ownerPkhFromChangeOutput(template: WireTransaction): Uint8Array {
  const changeScript = template.outputs[1]?.script_public_key?.script;
  if (typeof changeScript !== "string" || !P2PK_SCRIPT.test(changeScript)) {
    throw invalidError("template has no owner change output (P2PK)");
  }
  const pubkey = pubkeyFromP2pkScript(changeScript);
  if (!pubkey) throw invalidError("template change output is not a P2PK script");
  return pubkey;
}

interface WalletSignature {
  transactionId: string;
  index: number;
  signatureScript?: string;
}

function walletSignatures(signed: unknown): WalletSignature[] {
  let parsed: unknown = signed;
  if (typeof signed === "string") {
    try {
      parsed = JSON.parse(signed);
    } catch {
      throw invalidError("signed output is not valid JSON");
    }
  }
  const inputs =
    isRecord(parsed) && Array.isArray((parsed as { inputs?: unknown }).inputs)
      ? ((parsed as { inputs: unknown }).inputs as unknown[])
      : [];
  return inputs.map((input) => {
    if (!isRecord(input)) throw invalidError("signed input must be an object");
    return {
      transactionId: str(input.transactionId, "signed input transactionId"),
      index: input.index as number,
      ...(typeof input.signatureScript === "string"
        ? { signatureScript: input.signatureScript }
        : {}),
    };
  });
}

/**
 * Extract the raw 65-byte signature the wallet produced for an input. The wallet
 * returns it as a bare push (`41 <65 bytes>`); unwrap to the raw bytes for the
 * sig-script assembly.
 */
function rawSignature(signatureScript: string): Uint8Array {
  const bytes = hexToBytes(signatureScript);
  if (bytes.length === SIG_PUSH_LENGTH) return bytes;
  if (bytes.length === SIG_PUSH_LENGTH + 1 && bytes[0] === SIG_PUSH_LENGTH) {
    return bytes.slice(1);
  }
  throw invalidError("wallet signature must be a 65-byte push");
}

function signatureFor(
  signatures: readonly WalletSignature[],
  txid: string,
  index: number,
  label: string,
): Uint8Array {
  const found = signatures.find(
    (s) => s.transactionId.toLowerCase() === txid && s.index === index,
  );
  if (!found || typeof found.signatureScript !== "string") {
    throw invalidError(`${label} did not sign input ${index}`);
  }
  return rawSignature(found.signatureScript);
}

/**
 * finalize (KTK-129): merge the owner's and gate's signatures, assemble input
 * 0's mark_used sig-script, relay, and return the blockDAG verdict. The door
 * shows this verbatim — green on confirmed, red + the node's message otherwise.
 */
export async function useFinalize(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: UseGateContext,
): Promise<UseFinalizeResult> {
  const { txid: ticketTxid, index: ticketIndex } = parseTicketId(ticketIdValue);
  const req = parseFinalize(raw);
  const { template } = req;

  // The template's ticket input is input 0 (the covenant spend being marked used).
  const ticketInput = template.inputs[0];
  if (
    !ticketInput ||
    ticketInput.previous_outpoint.transaction_id.toLowerCase() !== ticketTxid ||
    ticketInput.previous_outpoint.index !== ticketIndex
  ) {
    throw invalidError("template input 0 is not the requested ticket");
  }

  const covenantIdHex = ticketCovenantId(template);
  const verified = await verifiedEvent(covenantIdHex, ctx);
  const artifact = verified.artifact;

  // Recover the ticket owner from the change output; rebuild the redeem the
  // ticket currently commits to for the spend reveal. v3: an unlisted coin
  // reveals sale_price 0; a listed one reveals its asking price (the index
  // proposes, the script equality below disposes). Check-in absorbs the
  // listing on chain — mark_used emits sale_price 0.
  const owner = ownerPkhFromChangeOutput(template);
  const liveScript = (
    await ctx.kaspa.getTransaction(ticketTxid)
  )?.outputs?.[ticketIndex]?.script_public_key;
  if (typeof liveScript !== "string") {
    throw notFoundError(`ticket ${ticketTxid}:${ticketIndex} not found on chain`);
  }
  const baseState = { owner, identifierType: 0 as const, amount: 1 as const, isMinter: false as const };
  let redeem = injectState(artifact, { ...baseState, used: false, salePrice: 0 });
  if (p2shScript(redeem).script !== liveScript.toLowerCase()) {
    const stored = ctx.listings.get(covenantIdHex, `${ticketTxid}:${ticketIndex}`);
    if (!stored) {
      throw invalidError("ticket is neither unlisted nor carries a known listing");
    }
    redeem = injectState(artifact, { ...baseState, used: false, salePrice: stored.price });
    if (p2shScript(redeem).script !== liveScript.toLowerCase()) {
      throw invalidError("stale or unknown listing — cannot assemble the check-in reveal");
    }
  }

  const ownerSigs = walletSignatures(req.owner_signed);
  const gateSigs = walletSignatures(req.gate_signed);
  const ownerSig = signatureFor(ownerSigs, ticketTxid, ticketIndex, "owner");
  const gateSig = signatureFor(gateSigs, ticketTxid, ticketIndex, "gate");

  // Assemble input 0's sig-script: push(65B owner_sig) || push(65B gate_sig) ||
  // push(dispatch_tag) || push(redeem) — pure kit assembly, byte-exact with silverc.
  const sigScript = bytesToHex(assembleMarkUsedSigScript(artifact, ownerSig, gateSig, redeem));

  // Merge the owner's fee-input signatures (inputs 1..); input 0 keeps the
  // assembled mark_used script.
  const merged: WireTransaction = {
    ...template,
    inputs: template.inputs.map((input, i) => {
      if (i === 0) return { ...input, signature_script: sigScript };
      const sig = ownerSigs.find(
        (s) =>
          s.transactionId.toLowerCase() === input.previous_outpoint.transaction_id &&
          s.index === input.previous_outpoint.index,
      );
      return {
        ...input,
        signature_script: sig?.signatureScript ?? input.signature_script,
      };
    }),
  };

  // Validate only that this is a covenant spend; the blockDAG is the judge.
  const txid = await broadcastAndConfirm(merged, {}, ctx, validateCovenantSpend);
  return { txid };
}

async function verifiedEvent(
  covenantIdHex: string,
  ctx: UseGateContext,
): Promise<VerifiedEvent> {
  const entry = ctx.byCovenantId(covenantIdHex);
  if (!entry) throw notFoundError(`event for ticket ${covenantIdHex} not found`);
  const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
  if (verified.covenant_id !== covenantIdHex) {
    throw invalidError("template ticket does not belong to the verified event");
  }
  return verified;
}

function validateCovenantSpend(tx: WireTransaction): void {
  if (!tx.outputs.some((o) => o.covenant !== null)) {
    throw policyError("transaction is not a covenant spend");
  }
}
