// Per-type transaction build strategies (KTK-88 A5). Each strategy knows how to
// turn its `BuildRequest` variant into a kit builder invocation given a fee,
// plus the input total / payouts the fee computation needs.
//
// Events are compiled per-event: the constants (authorizing_txid, price,
// org_spk, burn_template_hash) are constructor args baked into the bytecode at
// compile time, so every build compiles the event/burn artifacts for that
// event's constants before assembling the transaction.

import {
  buildBuy,
  buildDeploy,
  buildHandover,
  buildMarkUsed,
  injectState,
  pushData,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { burnTemplateHashOf, compileBurnArtifact, compileEventArtifact, eventMintSigScript } from "./compiler.js";
import type { BuildRequest, WireUtxo, WireUtxoMeta } from "./wire.js";
import { orgPayoutSpk, toCompilerConstants, toOutpoint, toSpk } from "./wire.js";

const TESTNET10 = "testnet10";

function utxoMetaOf(u: WireUtxo): WireUtxoMeta {
  return {
    transaction_id: u.transaction_id,
    index: u.index,
    value: u.value,
    script_public_key: { version: 0, script: "" },
    block_daa_score: 0,
    is_coinbase: false,
  };
}

export type BuiltTransaction = {
  tx: UnsignedTransaction;
  eventCovenantId?: string;
  covenantRedeemScript?: string;
};

export type PreparedBuild = {
  build: (fee: number) => BuiltTransaction;
  inputTotal: number;
  payouts: readonly number[];
  /**
   * Full prev-output metadata for every spending input, in input order â€” the
   * wallet needs these to sign (`signPskt` safe-JSON carries `utxo` per input).
   */
  inputUtxoMetas: WireUtxoMeta[];
};

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function deployBuild(req: BuildRequest & { type: "deploy" }): PreparedBuild {
  // The burn template hash is derived at compile time (authorizing_txid baked),
  // so the API is authoritative — the client-sent value is advisory.
  const burnHash = burnTemplateHashOf(req.constants.authorizing_txid);
  const eventArtifact = compileEventArtifact({
    ...toCompilerConstants(req.constants),
    burnTemplateHash: burnHash,
  });
  const values = [req.authorizing_outpoint.value, ...req.organizer_utxos.map((u) => u.value)];
  const metas =
    req.input_utxo_metas ?? [req.authorizing_outpoint, ...req.organizer_utxos].map(utxoMetaOf);
  const metadata =
    req.name !== undefined && req.date !== undefined
      ? {
          name: req.name,
          date: req.date,
          ...(req.time !== undefined ? { time: req.time } : {}),
          priceKAS: req.constants.price / 100_000_000,
          orgSpk: req.constants.org_spk,
          burnTemplateHash: burnHash,
        }
      : undefined;
  return {
    inputTotal: sum(values),
    payouts: [],
    inputUtxoMetas: metas,
    build: (fee) => {
      const deploy = buildDeploy({
        authorizingOutpoint: toOutpoint(req.authorizing_outpoint),
        organizerUtxos: req.organizer_utxos.map((u) => toOutpoint(u)),
        organizerUtxoValues: values,
        organizer: hexToBytes(req.organizer),
        capacity: req.capacity,
        eventArtifact,
        changeScript: toSpk(req.change_spk),
        fee,
        network: TESTNET10,
        ...(metadata ? { metadata } : {}),
      });
      return { tx: deploy.tx, eventCovenantId: deploy.eventCovenantId };
    },
  };
}

async function buyBuild(
  req: BuildRequest & { type: "buy" },
  kaspa: KaspaClientLike,
): Promise<PreparedBuild> {
  const eventArtifact = compileEventArtifact(toCompilerConstants(req.constants));

  const eventTx = await kaspa.getTransaction(req.event_outpoint.transaction_id);
  const eventOutput = eventTx?.outputs[req.event_outpoint.index];
  const eventMeta: WireUtxoMeta = {
    transaction_id: req.event_outpoint.transaction_id,
    index: req.event_outpoint.index,
    value: eventOutput?.amount ?? 0,
    script_public_key: eventOutput?.script_public_key
      ? { version: 0, script: eventOutput.script_public_key }
      : { version: 0, script: "" },
    block_daa_score: eventTx?.accepting_block_blue_score ?? 0,
    is_coinbase: false,
    covenant_id: req.event_covenant_id,
  };

  const buyerMetas = req.input_utxo_metas ?? req.buyer_utxos.map((u) => utxoMetaOf(u));
  const metas = [eventMeta, ...buyerMetas];

  return {
    inputTotal: eventMeta.value + req.buyer_utxos.reduce((a, u) => a + u.value, 0),
    payouts: req.constants.price > 0 ? [req.constants.price] : [],
    inputUtxoMetas: metas,
    build: (fee) => {
      const tx = buildBuy({
        eventOutpoint: toOutpoint(req.event_outpoint),
        eventCovenantId: req.event_covenant_id,
        eventOwner: hexToBytes(req.event_owner),
        eventArtifact,
        buyer: hexToBytes(req.buyer),
        buyerUtxos: req.buyer_utxos.map((u) => toOutpoint(u)),
        buyerUtxoValues: req.buyer_utxos.map((u) => u.value),
        orgScript: orgPayoutSpk(req.constants.org_spk),
        changeScript: toSpk(req.change_spk),
        remaining: req.remaining,
        price: req.constants.price,
        network: TESTNET10,
        fee,
      });
      return {
        tx,
        covenantRedeemScript:
          eventMintSigScript(toCompilerConstants(req.constants), req.buyer) +
          bytesToHex(pushData(eventRedeemPush(eventArtifact, req))),
      };
    },
  };
}

function eventRedeemPush(
  artifact: ReturnType<typeof compileEventArtifact>,
  req: { event_owner: string; remaining: number },
): Uint8Array {
  // P2SH reveal for the spent event covenant input: the wallet must provide the
  // full redeem script (bytecode with the current event state injected) so the
  // node can execute the covenant check.
  return injectState(artifact, {
    owner: hexToBytes(req.event_owner),
    identifierType: 0,
    amount: req.remaining,
    isMinter: false,
    used: false,
  });
}

function handoverBuild(req: BuildRequest & { type: "handover" }): PreparedBuild {
  const burnArtifact = compileBurnArtifact(req.constants.authorizing_txid);
  return {
    inputTotal: req.attendee_utxos.reduce((a, u) => a + u.value, 0),
    payouts: [],
    inputUtxoMetas: req.attendee_utxos.map((u) => utxoMetaOf(u)),
    build: (fee) => ({
      tx: buildHandover({
        ticketOutpoint: toOutpoint(req.ticket_outpoint),
        eventCovenantId: req.event_covenant_id,
        burnArtifact,
        attendeeUtxos: req.attendee_utxos.map((u) => toOutpoint(u)),
        attendeeUtxoValues: req.attendee_utxos.map((u) => u.value),
        changeScript: toSpk(req.change_spk),
        network: TESTNET10,
        fee,
      }),
    }),
  };
}

async function markUsedBuild(
  req: BuildRequest & { type: "markUsed" },
  kaspa: KaspaClientLike,
): Promise<PreparedBuild> {
  const eventArtifact = compileEventArtifact(toCompilerConstants(req.constants));

  // The ticket covenant UTXO (input index 0) — the wallet needs its full
  // prev-output metadata (script, amount, daa, covenant id) to co-sign it.
  const ticketTx = await kaspa.getTransaction(req.ticket_outpoint.transaction_id);
  const ticketOutput = ticketTx?.outputs[req.ticket_outpoint.index];
  const ticketMeta: WireUtxoMeta = {
    transaction_id: req.ticket_outpoint.transaction_id,
    index: req.ticket_outpoint.index,
    value: ticketOutput?.amount ?? 0,
    script_public_key: ticketOutput?.script_public_key
      ? { version: 0, script: ticketOutput.script_public_key }
      : { version: 0, script: "" },
    block_daa_score: ticketTx?.accepting_block_blue_score ?? 0,
    is_coinbase: false,
    covenant_id: req.event_covenant_id,
  };

  const ownerMetas = req.input_utxo_metas ?? req.owner_utxos.map((u) => utxoMetaOf(u));
  const metas = [ticketMeta, ...ownerMetas];

  return {
    inputTotal: ticketMeta.value + req.owner_utxos.reduce((a, u) => a + u.value, 0),
    payouts: [],
    inputUtxoMetas: metas,
    build: (fee) => ({
      tx: buildMarkUsed({
        ticketOutpoint: toOutpoint(req.ticket_outpoint),
        eventCovenantId: req.event_covenant_id,
        eventArtifact,
        owner: hexToBytes(req.owner),
        ownerUtxos: req.owner_utxos.map((u) => toOutpoint(u)),
        ownerUtxoValues: req.owner_utxos.map((u) => u.value),
        changeScript: toSpk(req.change_spk),
        network: TESTNET10,
        fee,
      }),
    }),
  };
}

export async function preparedBuildFor(
  request: BuildRequest,
  kaspa: KaspaClientLike,
): Promise<PreparedBuild> {
  switch (request.type) {
    case "deploy":
      return deployBuild(request);
    case "buy":
      return buyBuild(request, kaspa);
    case "handover":
      return handoverBuild(request);
    case "markUsed":
      return markUsedBuild(request, kaspa);
  }
}
