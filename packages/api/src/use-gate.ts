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

import { isRecord, str } from "./validate.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { KaspaNetwork } from "@kticket/kit";
import { invalidError, notFoundError } from "./errors.js";
import { signingTemplateFor } from "./tx.js";
import type { WireTransaction, WireUtxoMeta } from "./wire.js";

export interface UseGateContext {
  kaspa: KaspaClientLike;
  networkId: string;
  network: KaspaNetwork;
  /** Resolve the registry pointer for a covenant id (may be undefined). */
  byCovenantId: (covenantId: string) => { deployTxId: string } | undefined;
}

export interface UseSignTemplateResult {
  signing_template: string;
}

const TICKET_ID = /^([0-9a-fA-F]{64}):(\d+)$/;

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
