// Deploy flow (POST /v1/events/deploy/prepare + /deploy/finalize) — two
// stateless calls, all logic on the backend:
//
//   prepare  — backend fetches the organizer's UTXOs, validates, builds the
//              unsigned deploy template, and returns what the wallet must sign.
//              Issues a `deploy_id` the client echoes on finalize so ops can
//              spot abandoned prepares.
//   finalize — backend MERGES the wallet's signatures into the exact template
//              that was signed, validates it is a deploy, broadcasts, waits
//              for chain confirmation, then registers the event identifiers
//              locally. Success is returned only after registration.
//
// The frontend only relays: send the deploy inputs (prepare), hand the signing
// template to the wallet, and send back the template + the wallet's output
// (finalize). It never merges, retries, or owns pipeline state.

import { randomUUID } from "node:crypto";
import { BURN_ARTIFACT, kasToSompi, MAX_EVENT_CAPACITY, organizerPkh, orgSpkFromPublicKey } from "@kticket/kit";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { KaspaNetwork } from "@kticket/kit";
import { buildTransaction, broadcastTransaction, type TxContext } from "./tx.js";
import { invalidError, policyError } from "./errors.js";
import { mergeSignatures } from "./flow.js";
import { pollUntil } from "./poll-until.js";
import { verifyEventFromChain } from "./provenance.js";
import { isRecord, int, str, uint } from "./validate.js";
import type {
  BuildRequest,
  BuildResult,
  WireTransaction,
  WireUtxo,
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
  /** KCC-0021 standard token-metadata keys (display-only, optional). */
  ticker?: string;
  decimals?: number;
  image?: string;
  image_hash?: string;
}

export interface DeployFinalizeRequest {
  /** Correlation id issued by prepare — lets ops detect abandoned prepares. */
  deploy_id: string;
  /** The unsigned template returned by prepare (must be the exact one signed). */
  template: WireTransaction;
  /** The wallet's output from signing the template (signatures per input). */
  signed: unknown;
}

export interface DeployPrepareResult {
  /** Correlation id the client echoes back on finalize (see DeployFinalizeRequest). */
  deploy_id: string;
  signing_template: string;
  event_covenant_id?: string;
  /** The unsigned template the wallet signed — relayed back in finalize. */
  template: WireTransaction;
}

export interface DeployFinalizeResult {
  covenant_id: string;
  deploy_txid: string;
}

const COMPRESSED_PUBKEY_HEX_LEN = 66;
const X_COORD_HEX_LEN = 64;
const PUBKEY_HEX = /^[0-9a-fA-F]+$/;

/** Reference burn template hash (advisory — the backend derives the per-event one). */
function referenceBurnTemplateHash(): string {
  return bytesToHex(Uint8Array.from(BURN_ARTIFACT.template_hash));
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

function validatePublicKey(publicKey: unknown, label = "publicKey"): string {
  const key = str(publicKey, label).toLowerCase();
  if (!PUBKEY_HEX.test(key)) throw invalidError(`${label} must be hex`);
  if (key.length !== COMPRESSED_PUBKEY_HEX_LEN && key.length !== X_COORD_HEX_LEN) {
    throw invalidError(`${label} must be 66 or 64 hex chars`);
  }
  return key;
}

/** Parse + validate the prepare body. */
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

/** Build the deploy `BuildRequest` from organizer inputs + fetched UTXOs. */
function deployBuildRequest(req: DeployPrepareRequest, utxos: UtxoResponse[]): BuildRequest {
  const metas = utxos
    .filter((u) => u.outpoint && u.utxoEntry)
    .map(toWireUtxoMeta)
    .sort((a, b) => b.value - a.value);
  if (metas.length === 0) {
    throw policyError("no spendable UTXOs on the organizer address");
  }
  const authorizing = metas[0] as WireUtxoMeta;
  const organizer = organizerPkh(req.publicKey);
  const orgSpk = orgSpkFromPublicKey(req.publicKey);

  return {
    type: "deploy",
    capacity: req.capacity,
    constants: {
      authorizing_txid: authorizing.transaction_id,
      price: kasToSompi(req.price_kas),
      org_spk: orgSpk,
      burn_template_hash: referenceBurnTemplateHash(),
    },
    organizer,
    authorizing_outpoint: { transaction_id: authorizing.transaction_id, index: authorizing.index, value: authorizing.value },
    organizer_utxos: metas.slice(1).map((m) => ({
      transaction_id: m.transaction_id,
      index: m.index,
      value: m.value,
    })),
    change_spk: { version: 0, script: orgSpk },
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
 * prepare: fetch the organizer's UTXOs, build the unsigned template, return
 * what the wallet signs. The backend trusts only itself — it derives the
 * organizer pkh / payout script / change script from the public key.
 */
export async function deployPrepare(
  raw: unknown,
  ctx: DeployContext,
): Promise<DeployPrepareResult> {
  const req = parsePrepare(raw);
  const utxos = await ctx.kaspa.getUtxos(req.address);
  const buildRequest = deployBuildRequest(req, utxos);
  const result: BuildResult = await buildTransaction(buildRequest, {
    kaspa: ctx.kaspa,
    networkId: ctx.networkId,
  });
  if (!result.signing_template) {
    throw invalidError("could not build a signing template for the deploy");
  }
  return {
    deploy_id: randomUUID(),
    signing_template: result.signing_template,
    template: result.template,
    ...(result.event_covenant_id ? { event_covenant_id: result.event_covenant_id } : {}),
  };
}

const CONFIRM_MAX_ATTEMPTS = 5;
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
