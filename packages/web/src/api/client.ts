import type {
  BroadcastResult,
  BuildResult,
  WireOutpoint,
  WireScriptPublicKey,
  WireUtxo,
  WireUtxoMeta,
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

export interface DeployBuildRequest {
  capacity: number;
  authorizingTxId: string;
  price: number;
  orgSpk: string;
  burnTemplateHash: string;
  organizer: string;
  authorizingOutpoint: WireUtxo;
  organizerUtxos: WireUtxo[];
  changeSpk: WireScriptPublicKey;
  inputUtxoMetas: WireUtxoMeta[];
}

export function buildDeployTx(req: DeployBuildRequest): Promise<BuildResult> {
  return apiFetch<BuildResult>("/v1/tx/build", {
    type: "deploy",
    capacity: req.capacity,
    constants: {
      authorizing_txid: req.authorizingTxId,
      price: req.price,
      org_spk: req.orgSpk,
      burn_template_hash: req.burnTemplateHash,
    },
    organizer: req.organizer,
    authorizing_outpoint: req.authorizingOutpoint,
    organizer_utxos: req.organizerUtxos,
    change_spk: req.changeSpk,
    input_utxo_metas: req.inputUtxoMetas,
  });
}

export function broadcastTx(transaction: unknown): Promise<BroadcastResult> {
  return apiFetch<BroadcastResult>("/v1/tx/broadcast", { transaction });
}

/** Fetch event detail + availability from the API. */
export interface EventDetail {
  event: {
    covenant_id: string;
    genesis_txid: string;
    name: string;
    date: string;
    price: number;
    capacity: number;
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
  genesis_txid: string;
  name: string;
  date: string;
}

export function fetchEventsList(orgPkh?: string): Promise<EventListItem[]> {
  const query = orgPkh ? `?org_pkh=${encodeURIComponent(orgPkh)}` : "";
  return apiGet<EventListItem[]>(`/v1/events${query}`);
}

export interface RegisterEventPayload {
  authorizing_txid: string;
  genesis_txid: string;
  org_pkh: string;
  org_spk: string;
  burn_template_hash: string;
  name: string;
  date: string;
  price: number;
  capacity: number;
}

export function registerEvent(payload: RegisterEventPayload): Promise<{ covenant_id: string }> {
  return apiFetch<{ covenant_id: string }>("/v1/events", payload);
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
