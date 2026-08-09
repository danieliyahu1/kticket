// Per-type transaction build strategies (HLD v0.22 §2.1). Each strategy knows
// how to turn its `BuildRequest` variant into a kit builder invocation given a
// fee, plus the input total / payouts the fee computation needs.

import {
  BURN_ARTIFACT,
  buildBuy,
  buildDeploy,
  buildHandover,
  buildTransfer,
  EVENT_ARTIFACT,
  type UnsignedTransaction,
} from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { BuildRequest, WireUtxo, WireUtxoMeta } from "./wire.js";
import { codeBytes, orgPayoutSpk, toDecodedConstants, toOutpoint, toSpk } from "./wire.js";

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
};

export type PreparedBuild = {
  build: (fee: number) => BuiltTransaction;
  inputTotal: number;
  payouts: readonly number[];
  /**
   * Full prev-output metadata for every spending input, in input order — the
   * wallet needs these to sign (`signPskt` safe-JSON carries `utxo` per input).
   */
  inputUtxoMetas: WireUtxoMeta[];
};

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function deployBuild(req: BuildRequest & { type: "deploy" }): PreparedBuild {
  const constants = toDecodedConstants(req.constants);
  const values = [req.authorizing_outpoint.value, ...req.organizer_utxos.map((u) => u.value)];
  const metas =
    req.input_utxo_metas ?? [req.authorizing_outpoint, ...req.organizer_utxos].map(utxoMetaOf);
  const metadata =
    req.name !== undefined && req.date !== undefined
      ? { name: req.name, date: req.date, price: req.constants.price }
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
        constants,
        covenantCode: codeBytes(EVENT_ARTIFACT.code),
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
  const constants = toDecodedConstants(req.constants);

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
  };

  const buyerMetas = req.input_utxo_metas ?? req.buyer_utxos.map((u) => utxoMetaOf(u));
  const metas = [eventMeta, ...buyerMetas];

  return {
    inputTotal: eventMeta.value + req.buyer_utxos.reduce((a, u) => a + u.value, 0),
    payouts: req.constants.price > 0 ? [req.constants.price] : [],
    inputUtxoMetas: metas,
    build: (fee) => ({
      tx: buildBuy({
        eventOutpoint: toOutpoint(req.event_outpoint),
        eventCovenantId: req.event_covenant_id,
        eventOwner: hexToBytes(req.event_owner),
        constants,
        buyer: hexToBytes(req.buyer),
        buyerUtxos: req.buyer_utxos.map((u) => toOutpoint(u)),
        buyerUtxoValues: req.buyer_utxos.map((u) => u.value),
        orgScript: orgPayoutSpk(req.constants.org_spk),
        changeScript: toSpk(req.change_spk),
        covenantCode: codeBytes(EVENT_ARTIFACT.code),
        remaining: req.remaining,
        network: TESTNET10,
        fee,
      }),
    }),
  };
}

function transferBuild(req: BuildRequest & { type: "transfer" }): PreparedBuild {
  const constants = toDecodedConstants(req.constants);
  return {
    inputTotal: req.holder_utxos.reduce((a, u) => a + u.value, 0),
    payouts: [],
    inputUtxoMetas: req.holder_utxos.map((u) => utxoMetaOf(u)),
    build: (fee) => ({
      tx: buildTransfer({
        ticketOutpoint: toOutpoint(req.ticket_outpoint),
        eventCovenantId: req.event_covenant_id,
        constants,
        newOwner: hexToBytes(req.new_owner),
        holderUtxos: req.holder_utxos.map((u) => toOutpoint(u)),
        holderUtxoValues: req.holder_utxos.map((u) => u.value),
        changeScript: toSpk(req.change_spk),
        covenantCode: codeBytes(EVENT_ARTIFACT.code),
        network: TESTNET10,
        fee,
      }),
    }),
  };
}

function handoverBuild(req: BuildRequest & { type: "handover" }): PreparedBuild {
  const constants = toDecodedConstants(req.constants);
  return {
    inputTotal: req.attendee_utxos.reduce((a, u) => a + u.value, 0),
    payouts: [],
    inputUtxoMetas: req.attendee_utxos.map((u) => utxoMetaOf(u)),
    build: (fee) => ({
      tx: buildHandover({
        ticketOutpoint: toOutpoint(req.ticket_outpoint),
        eventCovenantId: req.event_covenant_id,
        constants,
        burnCode: codeBytes(BURN_ARTIFACT.code),
        attendeeUtxos: req.attendee_utxos.map((u) => toOutpoint(u)),
        attendeeUtxoValues: req.attendee_utxos.map((u) => u.value),
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
    case "transfer":
      return transferBuild(request);
    case "handover":
      return handoverBuild(request);
  }
}
