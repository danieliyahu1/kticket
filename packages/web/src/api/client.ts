import type {
  BroadcastResult,
  BuildResult,
  DeployPrepareRequest,
  DeployPrepareResult,
  WireOutpoint,
  WireScriptPublicKey,
  WireUtxo,
  WireUtxoMeta,
  WireTransaction,
} from "./types";

async function apiFetch<T>(path: string, body: unknown): Promise<T> {
  const url = path;
  console.log(`[api] POST ${url}`, JSON.stringify(body));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[api] fetch failed: ${url}`, err);
    throw new Error("No connection");
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`[api] ${res.status} ${url}`, text);
    const json = parseErrorJson(text);
    const msg = json?.error?.message ?? `API error ${res.status}`;
    if (msg.toLowerCase().includes("fee") || msg.toLowerCase().includes("mass")) {
      throw new Error("Not enough funds");
    }
    throw new Error(msg);
  }

  const text = await res.text();
  console.log(`[api] 200 ${url}`, text);
  return JSON.parse(text) as T;
}

function parseErrorJson(text: string): { error?: { message?: string } } | null {
  try {
    return JSON.parse(text) as { error?: { message?: string } };
  } catch {
    return null;
  }
}

export function broadcastTx(transaction: unknown): Promise<BroadcastResult> {
  return apiFetch<BroadcastResult>("/v1/tx/broadcast", { transaction });
}

/** prepare: backend fetches UTXOs + builds the unsigned template the wallet signs. */
export function deployPrepare(req: DeployPrepareRequest): Promise<DeployPrepareResult> {
  return apiFetch<DeployPrepareResult>("/v1/events/deploy", req);
}

/** finalize: backend merges the signature, broadcasts, confirms, and registers. */
export function deployFinalize(req: {
  phase: "finalize";
  template: WireTransaction;
  signed: unknown;
}): Promise<{ covenant_id: string; deploy_txid: string }> {
  return apiFetch<{ covenant_id: string; deploy_txid: string }>("/v1/events/deploy", req);
}

/** Fetch event detail + availability from the API (KTK-89: chain-verified). */
export interface EventDetail {
  event: {
    covenant_id: string;
    deploy_txid: string;
    name: string;
    date: string;
    price: number;
    capacity: number;
    organizer_address: string;
    verified: boolean;
  };
  availability: {
    capacity: number;
    sold: number;
    left: number;
  };
  buy_info: {
    event_owner: string;
    org_spk: string;
    burn_template_hash: string;
    authorizing_txid: string;
    event_covenant_id: string;
    event_txid: string;
    event_index: number;
    remaining: number;
  };
  raw_chain: {
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
  };
}

async function apiGet<T>(path: string): Promise<T> {
  console.log(`[api] GET ${path}`);
  let res: Response;
  try {
    res = await fetch(path);
  } catch (err) {
    console.error(`[api] fetch GET failed: ${path}`, err);
    throw new Error("No connection");
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`[api] ${res.status} ${path}`, text);
    const json = parseErrorJson(text);
    throw new Error(json?.error?.message ?? `API error ${res.status}`);
  }
  const text = await res.text();
  console.log(`[api] 200 ${path}`, text);
  return JSON.parse(text) as T;
}

export function fetchEvent(covenantId: string): Promise<EventDetail> {
  return apiGet<EventDetail>(`/v1/events/${covenantId}`);
}

export interface EventListItem {
  covenant_id: string;
  deploy_txid: string;
  organizer_address: string;
}

export function fetchEventsList(organizerAddress?: string): Promise<EventListItem[]> {
  const query = organizerAddress
    ? `?organizer_address=${encodeURIComponent(organizerAddress)}`
    : "";
  return apiGet<EventListItem[]>(`/v1/events${query}`);
}

export interface BuyBuildRequest {
  event_outpoint: WireOutpoint;
  event_covenant_id: string;
  event_owner: string;
  remaining: number;
  authorizingTxId: string;
  price: number;
  orgSpk: string;
  burnTemplateHash: string;
  buyer: string;
  buyerUtxos: WireUtxo[];
  changeSpk: WireScriptPublicKey;
  inputUtxoMetas?: WireUtxoMeta[];
}

export function buildBuyTx(req: BuyBuildRequest): Promise<BuildResult> {
  return apiFetch<BuildResult>("/v1/tx/build", {
    type: "buy",
    event_outpoint: req.event_outpoint,
    event_covenant_id: req.event_covenant_id,
    event_owner: req.event_owner,
    remaining: req.remaining,
    constants: {
      authorizing_txid: req.authorizingTxId,
      price: req.price,
      org_spk: req.orgSpk,
      burn_template_hash: req.burnTemplateHash,
    },
    buyer: req.buyer,
    buyer_utxos: req.buyerUtxos,
    change_spk: req.changeSpk,
    ...(req.inputUtxoMetas ? { input_utxo_metas: req.inputUtxoMetas } : {}),
  });
}

export interface TransferBuildRequest {
  ticket_outpoint: WireOutpoint;
  event_covenant_id: string;
  authorizingTxId: string;
  price: number;
  orgSpk: string;
  burnTemplateHash: string;
  new_owner: string;
  holderUtxos: WireUtxo[];
  changeSpk: WireScriptPublicKey;
  inputUtxoMetas?: WireUtxoMeta[];
}

export function buildTransferTx(req: TransferBuildRequest): Promise<BuildResult> {
  return apiFetch<BuildResult>("/v1/tx/build", {
    type: "transfer",
    ticket_outpoint: req.ticket_outpoint,
    event_covenant_id: req.event_covenant_id,
    constants: {
      authorizing_txid: req.authorizingTxId,
      price: req.price,
      org_spk: req.orgSpk,
      burn_template_hash: req.burnTemplateHash,
    },
    new_owner: req.new_owner,
    holder_utxos: req.holderUtxos,
    change_spk: req.changeSpk,
    ...(req.inputUtxoMetas ? { input_utxo_metas: req.inputUtxoMetas } : {}),
  });
}

export { type WireOutpoint };

export interface TicketEntry {
  ticket_id: string;
  covenant_id: string;
  event_name: string;
  event_date: string;
}

async function fetchMyTickets(ownerPkh: string): Promise<TicketEntry[]> {
  return apiGet<TicketEntry[]>(`/v1/tickets?owner_pkh=${encodeURIComponent(ownerPkh)}`);
}

const RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 2;

export async function fetchMyTicketsWithRetry(ownerPkh: string): Promise<TicketEntry[]> {
  let delay = RETRY_DELAY_MS;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const tickets = await fetchMyTickets(ownerPkh);
    if (tickets.length > 0) return tickets;
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  return [];
}
