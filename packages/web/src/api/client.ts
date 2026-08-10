import type {
  DeployPrepareRequest,
  DeployPrepareResult,
  WireOutpoint,
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

export interface BuyPrepareResult {
  signing_template: string;
  template: WireTransaction;
  sign_inputs: { index: number }[];
  price: number;
}

/** prepare: backend verifies the event + fetches the buyer's UTXOs + builds the template. */
export function buyPrepare(
  covenantId: string,
  req: { phase: "prepare"; publicKey: string; address: string },
): Promise<BuyPrepareResult> {
  return apiFetch<BuyPrepareResult>(`/v1/events/${covenantId}/buy`, req);
}

/** finalize: backend merges, broadcasts, and waits for confirmation. */
export function buyFinalize(
  covenantId: string,
  req: { phase: "finalize"; template: WireTransaction; signed: unknown },
): Promise<{ txid: string }> {
  return apiFetch<{ txid: string }>(`/v1/events/${covenantId}/buy`, req);
}

export interface TransferPrepareResult {
  signing_template: string;
  template: WireTransaction;
  sign_inputs: { index: number }[];
}

/** prepare: backend resolves the event + fetches the holder's UTXOs + builds the template. */
export function transferPrepare(
  ticketId: string,
  req: { phase: "prepare"; covenant_id: string; ticket_id: string; publicKey: string; address: string },
): Promise<TransferPrepareResult> {
  return apiFetch<TransferPrepareResult>(`/v1/tickets/${encodeURIComponent(ticketId)}/transfer`, req);
}

/** finalize: backend merges, broadcasts, and waits for confirmation. */
export function transferFinalize(
  ticketId: string,
  req: { phase: "finalize"; template: WireTransaction; signed: unknown },
): Promise<{ txid: string }> {
  return apiFetch<{ txid: string }>(`/v1/tickets/${encodeURIComponent(ticketId)}/transfer`, req);
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

export { type WireOutpoint };

export interface TicketEntry {
  ticket_id: string;
  covenant_id: string;
  event_name: string;
  event_date: string;
}

/** Fetch the connected user's on-chain tickets. Confirmation already happened backend-side. */
export function fetchMyTickets(ownerPkh: string): Promise<TicketEntry[]> {
  return apiGet<TicketEntry[]>(`/v1/tickets?owner_pkh=${encodeURIComponent(ownerPkh)}`);
}
