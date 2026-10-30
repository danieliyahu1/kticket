// Deploy flow (POST /v1/events/deploy/prepare, /deploy/genesis, /deploy/finalize)
// — three stateless calls, all logic on the backend. Deploying an event under
// KCC-23 takes two transactions, so signing takes two rounds:
//
//   prepare  — backend fetches the organizer's UTXOs, builds the unsigned KCC-23
//              *preparation* template (metadata declaration in the payload), and
//              returns what the wallet must sign. Issues a `deploy_id` the
//              client echoes on the next calls so ops can spot abandoned flows.
//   genesis  — backend merges the preparation signatures, broadcasts it, waits
//              for it to be accepted, then builds the genesis template spending
//              the preparation output (input 0). Returns what the wallet signs.
//   finalize — backend MERGES the wallet's signatures into the exact genesis
//              template that was signed, validates it is a deploy, broadcasts,
//              waits for chain confirmation, then registers the event
//              identifiers locally.
//
// The covenant id commits to the preparation txid (through the spent outpoint)
// and the preparation txid commits to the metadata payload, so the declaration
// is bound to the token. The frontend only relays: it sends the deploy inputs,
// hands each signing template to the wallet, and sends back the template + the
// wallet's output. It never merges, retries, or owns pipeline state.

import { randomUUID } from "node:crypto";
import {
  BURN_ARTIFACT,
  decodeMetadataFromPayload,
  kasToSompi,
  MAX_EVENT_CAPACITY,
  organizerPkh,
  orgSpkFromPublicKey,
} from "@kticket/kit";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { KaspaNetwork } from "@kticket/kit";
import { buildTransaction, broadcastTransaction, type TxContext } from "./tx.js";
import { invalidError, isApiError, policyError } from "./errors.js";
import { broadcastAndConfirm, mergeSignatures, waitForAcceptance } from "./flow.js";
import { pollUntil } from "./poll-until.js";
import { verifyEventFromChain } from "./provenance.js";
import { transactionIdOf } from "./wrpc-client.js";
import { isRecord, int, str, uint } from "./validate.js";
import type {
  BuildRequest,
  BuildResult,
  WireTransaction,
  WireUtxoMeta,
} from "./wire.js";
import type { UtxoResponse } from "./kaspa-types.js";

export interface DeployContext extends TxContext {
  network: KaspaNetwork;
  /** Where verified event identifiers are persisted locally. */
  register: (e: {
    deployTxId: string;
    covenantId: string;
    organizerAddress: string;
  }) => Promise<void>;
}

export interface DeployPrepareRequest {
  capacity: number;
  /** Ticket price in KAS (the backend converts KAS → sompi itself). */
  price_kas: number;
  /** Compressed (66-hex) or bare x-coordinate (64-hex) organizer public key. */
  publicKey: string;
  /** The organizer's bech32 address — the backend fetches its UTXOs itself. */
  address: string;
  name?: string;
  date?: string;
  /** Local wall-clock start time (HH:MM). */
  time?: string;
  /** Ecosystem token-metadata keys (display-only, optional). */
  ticker?: string;
  decimals?: number;
  image?: string;
  image_hash?: string;
}

/** One of the two signing rounds: the unsigned template plus what the wallet returned. */
export interface SignedTemplate {
  template: WireTransaction;
  signed: unknown;
}

export interface DeployGenesisRequest extends DeployPrepareRequest {
  /** Correlation id issued by prepare. */
  deploy_id: string;
  /** The preparation template the wallet signed. */
  preparation: SignedTemplate;
}

export interface DeployFinalizeRequest {
  /** Correlation id issued by prepare — lets ops detect abandoned prepares. */
  deploy_id: string;
  /** The unsigned genesis template returned by genesis (must be the exact one signed). */
  template: WireTransaction;
  /** The wallet's output from signing the template (signatures per input). */
  signed: unknown;
}

export interface DeployPrepareResult {
  /** Correlation id the client echoes back on genesis and finalize. */
  deploy_id: string;
  /** The KCC-23 preparation transaction: payload + output the genesis tx spends. */
  preparation: {
    template: WireTransaction;
    signing_template: string;
  };
}

export interface DeployGenesisResult {
  /** The preparation txid — the tx whose payload commits the metadata. */
  preparation_txid: string;
  event_covenant_id: string;
  /** The genesis transaction: it spends the preparation output at input 0. */
  genesis: {
    template: WireTransaction;
    signing_template: string;
  };
}

export interface DeployFinalizeResult {
  covenant_id: string;
  deploy_txid: string;
}

const COMPRESSED_PUBKEY_HEX_LEN = 66;
const X_COORD_HEX_LEN = 64;
const PUBKEY_HEX = /^[0-9a-fA-F]+$/;
const SOMPI_PER_KAS = 100_000_000;

/** Reference burn template hash (advisory — the backend derives the per-event one). */
function referenceBurnTemplateHash(): string {
  return bytesToHex(Uint8Array.from(BURN_ARTIFACT.template_hash));
}

function toWireUtxo(u: UtxoResponse) {
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

function spendableUtxos(utxos: UtxoResponse[]): UtxoResponse[] {
  return utxos
    .filter((u) => u.outpoint && u.utxoEntry && u.outpoint.transactionId)
    .sort((a, b) => Number(b.utxoEntry.amount) - Number(a.utxoEntry.amount));
}

function validatePublicKey(publicKey: unknown, label = "publicKey"): string {
  const key = str(publicKey, label).toLowerCase();
  if (!PUBKEY_HEX.test(key)) throw invalidError(`${label} must be hex`);
  if (key.length !== COMPRESSED_PUBKEY_HEX_LEN && key.length !== X_COORD_HEX_LEN) {
    throw invalidError(`${label} must be 66 or 64 hex chars`);
  }
  return key;
}

/** Parse + validate the prepare body (also the base of the genesis body). */
function parsePrepare(raw: unknown): DeployPrepareRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const capacity = int(raw.capacity, "capacity");
  if (capacity < 0 || capacity > MAX_EVENT_CAPACITY) {
    throw invalidError(`capacity must be 0..${MAX_EVENT_CAPACITY}`);
  }
  if (typeof raw.price_kas !== "number" || !Number.isFinite(raw.price_kas) || raw.price_kas < 0) {
    throw invalidError("price_kas must be a non-negative number");
  }
  const publicKey = validatePublicKey(raw.publicKey);
  const address = str(raw.address, "address");
  const name = raw.name === undefined ? undefined : str(raw.name, "name");
  const date = raw.date === undefined ? undefined : str(raw.date, "date");
  const time = raw.time === undefined ? undefined : str(raw.time, "time");
  if ((name === undefined) !== (date === undefined)) {
    throw invalidError("name and date must be provided together");
  }
  if (time !== undefined && date === undefined) {
    throw invalidError("time requires a date");
  }
  const decimals = raw.decimals === undefined ? undefined : uint(raw.decimals, "decimals");
  if (decimals !== undefined && decimals > 255) {
    throw invalidError("decimals must be 0..255");
  }
  return {
    capacity,
    price_kas: raw.price_kas,
    publicKey,
    address,
    ...(name ? { name } : {}),
    ...(date ? { date } : {}),
    ...(time ? { time } : {}),
    ...(raw.ticker !== undefined ? { ticker: str(raw.ticker, "ticker") } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(raw.image !== undefined ? { image: str(raw.image, "image") } : {}),
    ...(raw.image_hash !== undefined ? { image_hash: str(raw.image_hash, "image_hash") } : {}),
  };
}

function parseSignedTemplate(value: unknown, label: string): SignedTemplate {
  if (!isRecord(value)) throw invalidError(`${label} must be an object`);
  if (!isRecord(value.template)) throw invalidError(`${label}.template must be an object`);
  const template = value.template as unknown as WireTransaction;
  if (!Array.isArray(template.inputs) || !Array.isArray(template.outputs)) {
    throw invalidError(`${label}.template must be a valid transaction`);
  }
  if (typeof value.signed !== "string" && typeof value.signed !== "object") {
    throw invalidError(`${label}.signed must be the wallet's signing output`);
  }
  return { template, signed: value.signed };
}

/** Parse + validate the genesis body: the prepare fields plus the signed prep. */
function parseGenesis(raw: unknown): DeployGenesisRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const deploy_id = str(raw.deploy_id, "deploy_id");
  const preparation = parseSignedTemplate(raw.preparation, "preparation");
  return { ...parsePrepare(raw), deploy_id, preparation };
}

/** Parse + validate the finalize body. */
function parseFinalize(raw: unknown): DeployFinalizeRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const deploy_id = str(raw.deploy_id, "deploy_id");
  if (!isRecord(raw.template)) throw invalidError("template must be an object");
  const template = raw.template as unknown as WireTransaction;
  if (!Array.isArray(template.inputs) || !Array.isArray(template.outputs)) {
    throw invalidError("template must be a valid transaction");
  }
  if (typeof raw.signed !== "string" && typeof raw.signed !== "object") {
    throw invalidError("signed must be the wallet's signing output");
  }
  return { deploy_id, template, signed: raw.signed };
}

/** Build the preparation `BuildRequest` from the organizer's fetched UTXOs. */
function preparationBuildRequest(req: DeployPrepareRequest, utxos: UtxoResponse[]): BuildRequest {
  const metas = spendableUtxos(utxos).map(toWireUtxoMeta);
  if (metas.length === 0) {
    throw policyError("no spendable UTXOs on the organizer address");
  }
  const orgSpk = orgSpkFromPublicKey(req.publicKey);
  return {
    type: "deployPreparation",
    payer_utxos: metas.map((m) => ({
      transaction_id: m.transaction_id,
      index: m.index,
      value: m.value,
    })),
    owner_spk: { version: 0, script: orgSpk },
    price: kasToSompi(req.price_kas),
    org_spk: orgSpk,
    input_utxo_metas: metas,
    ...(req.name !== undefined ? { name: req.name } : {}),
    ...(req.date !== undefined ? { date: req.date } : {}),
    ...(req.time !== undefined ? { time: req.time } : {}),
    ...(req.ticker !== undefined ? { ticker: req.ticker } : {}),
    ...(req.decimals !== undefined ? { decimals: req.decimals } : {}),
    ...(req.image !== undefined ? { image: req.image } : {}),
    ...(req.image_hash !== undefined ? { image_hash: req.image_hash } : {}),
  };
}

/**
 * Validate the preparation template *before* it is relayed: it must be a
 * version 1 tx with exactly one non-covenant output paying the organizer, and a
 * KCC-23 payload that declares exactly what this deploy request asked for.
 * Anything else would bind metadata the caller did not request (or bind none
 * at all) while still creating a valid-looking event.
 */
function assertPreparation(template: WireTransaction, req: DeployPrepareRequest): void {
  if (template.version !== 1) {
    throw invalidError("the preparation transaction must be version 1 (KCC-23)");
  }
  if (template.inputs.length === 0) {
    throw invalidError("the preparation transaction has no inputs");
  }
  const output = template.outputs[0];
  if (template.outputs.length !== 1 || !output) {
    throw invalidError("the preparation transaction must have exactly one output");
  }
  if (output.covenant) {
    throw invalidError("the preparation output must not be a covenant output");
  }
  const orgSpk = orgSpkFromPublicKey(req.publicKey);
  if (output.script_public_key.script.toLowerCase() !== orgSpk.toLowerCase()) {
    throw invalidError("the preparation output must pay the organizer");
  }
  if (req.name === undefined || req.date === undefined) return;

  const declared = decodeMetadataFromPayload(template.payload);
  if (!declared) {
    throw invalidError("the preparation payload is not a valid KCC-23 declaration");
  }
  const price = kasToSompi(req.price_kas);
  const matches =
    declared.name === req.name &&
    declared.date === req.date &&
    (declared.time ?? "") === (req.time ?? "") &&
    (declared.ticker ?? "") === (req.ticker ?? "") &&
    (declared.decimals ?? 0) === (req.decimals ?? 0) &&
    (declared.image ?? "") === (req.image ?? "") &&
    (declared.image_hash ?? "") === (req.image_hash ?? "") &&
    Math.round(declared.priceKAS * SOMPI_PER_KAS) === price &&
    declared.orgSpk.toLowerCase() === orgSpk.toLowerCase();
  if (!matches) {
    throw invalidError("the preparation payload does not declare this deploy request");
  }
}

/**
 * prepare: fetch the organizer's UTXOs, build the unsigned KCC-23 preparation
 * template, return what the wallet signs. The backend trusts only itself — it
 * derives the organizer payout / prep output script from the public key.
 */
export async function deployPrepare(
  raw: unknown,
  ctx: DeployContext,
): Promise<DeployPrepareResult> {
  const req = parsePrepare(raw);
  const utxos = await ctx.kaspa.getUtxos(req.address);
  const result: BuildResult = await buildTransaction(preparationBuildRequest(req, utxos), {
    kaspa: ctx.kaspa,
    networkId: ctx.networkId,
  });
  if (!result.signing_template) {
    throw invalidError("could not build a signing template for the preparation transaction");
  }
  return {
    deploy_id: randomUUID(),
    preparation: {
      template: result.template,
      signing_template: result.signing_template,
    },
  };
}

/**
 * genesis: relay the signed preparation tx, wait until it is accepted, then
 * build the genesis template that spends its output 0 (the authorizing input).
 * The covenant id is only knowable now — it commits to the preparation txid.
 */
export async function deployGenesis(
  raw: unknown,
  ctx: DeployContext,
): Promise<DeployGenesisResult> {
  const req = parseGenesis(raw);
  assertPreparation(req.preparation.template, req);

  const merged = mergeSignatures(req.preparation.template, req.preparation.signed);
  assertPreparation(merged, req);
  const preparationTxid = await transactionIdOf(merged);

  if (!(await ctx.kaspa.getTransaction(preparationTxid))) {
    try {
      // The outcome's acceptance is not acted on here: the spendability check
      // below is what genesis actually needs, and it fails with a clear retry
      // message when the ledger has not accepted the preparation tx.
      await broadcastAndConfirm(
        req.preparation.template,
        req.preparation.signed,
        { kaspa: ctx.kaspa, networkId: ctx.networkId },
        (broadcast) => assertPreparation(broadcast, req),
      );
    } catch (err) {
      // A retried genesis whose preparation tx was already relayed: the signed
      // bytes — and therefore the txid — are identical, so wait for it instead
      // of failing the retry (nothing is double-spent).
      if (!(isApiError(err) && err.type === "conflict")) throw err;
      // Same rule as above: only acceptance makes the output spendable, and the
      // check below reports it best.
      await waitForAcceptance(ctx.kaspa, preparationTxid);
    }
  }
  ctx.kaspa.clearCache();

  // The genesis tx spends the preparation output; its full prev-output metadata
  // (script, amount, daa score) is needed for the wallet to sign.
  const utxos = spendableUtxos(await ctx.kaspa.getUtxos(req.address));
  const preparationUtxo = utxos.find(
    (u) => u.outpoint.transactionId.toLowerCase() === preparationTxid && u.outpoint.index === 0,
  );
  if (!preparationUtxo) {
    throw invalidError("the preparation output is not spendable yet — retry genesis");
  }
  const meta = toWireUtxoMeta(preparationUtxo);
  const orgSpk = orgSpkFromPublicKey(req.publicKey);

  const result: BuildResult = await buildTransaction(
    {
      type: "deploy",
      capacity: req.capacity,
      constants: {
        authorizing_txid: preparationTxid,
        price: kasToSompi(req.price_kas),
        org_spk: orgSpk,
        burn_template_hash: referenceBurnTemplateHash(),
      },
      organizer: organizerPkh(req.publicKey),
      authorizing_outpoint: toWireUtxo(preparationUtxo),
      organizer_utxos: [],
      change_spk: { version: 0, script: orgSpk },
      input_utxo_metas: [meta],
    },
    { kaspa: ctx.kaspa, networkId: ctx.networkId },
  );
  if (!result.signing_template || !result.event_covenant_id) {
    throw invalidError("could not build a signing template for the genesis transaction");
  }
  return {
    preparation_txid: preparationTxid,
    event_covenant_id: result.event_covenant_id,
    genesis: {
      template: result.template,
      signing_template: result.signing_template,
    },
  };
}

const CONFIRM_MAX_ATTEMPTS = 9;
const CONFIRM_BASE_DELAY_MS = 1_000;
const CONFIRM_MAX_DELAY_MS = 16_000;

/**
 * Wait until the deploy tx is verifiable on chain, then register the event
 * identifiers locally. `pollUntil` owns the timing; this flow owns the
 * "verifiable, not just visible" policy (deploys must also pass on-chain
 * verification before the event is real).
 */
async function confirmAndRegister(
  txid: string,
  ctx: DeployContext,
): Promise<DeployFinalizeResult> {
  let lastErr: unknown;
  const verified = await pollUntil(
    async () => {
      try {
        return await verifyEventFromChain(ctx.kaspa, ctx.network, txid);
      } catch (err) {
        lastErr = err;
        return undefined;
      }
    },
    {
      maxAttempts: CONFIRM_MAX_ATTEMPTS,
      baseDelayMs: CONFIRM_BASE_DELAY_MS,
      maxDelayMs: CONFIRM_MAX_DELAY_MS,
    },
  );
  if (!verified) {
    throw lastErr instanceof Error
      ? invalidError(`deploy not confirmed on chain: ${lastErr.message}`)
      : invalidError("deploy not confirmed on chain");
  }
  await ctx.register({
    deployTxId: verified.deploy_txid,
    covenantId: verified.covenant_id,
    organizerAddress: verified.organizer_address,
  });
  return { covenant_id: verified.covenant_id, deploy_txid: verified.deploy_txid };
}

/**
 * finalize: merge the wallet's signatures, validate it is a deploy, broadcast,
 * wait for confirmation, register. Returns success only once registered.
 */
export async function deployFinalize(
  raw: unknown,
  ctx: DeployContext,
): Promise<DeployFinalizeResult> {
  const req = parseFinalize(raw);
  const merged = mergeSignatures(req.template, req.signed);
  if (!merged.outputs.some((o) => o.covenant !== null)) {
    throw invalidError("template is not a deploy (no covenant output)");
  }
  const { txid } = await broadcastTransaction({ transaction: merged }, {
    kaspa: ctx.kaspa,
    networkId: ctx.networkId,
  });
  return confirmAndRegister(txid, ctx);
}
