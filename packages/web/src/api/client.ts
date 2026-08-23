import type {
  DeployPrepareRequest,
  DeployPrepareResult,
  WireOutpoint,
  WireTransaction,
} from "./types";

/** An API error carrying the backend's taxonomy (type / message / retryable). */
export class ApiError extends Error {
  readonly type: string | undefined;
  readonly retryable: boolean | undefined;

  constructor(message: string, type?: string, retryable?: boolean) {
    super(message);
    this.name = "ApiError";
    this.type = type;
    this.retryable = retryable;
  }
}

/** The server could not complete the request — unreachable, or it failed (any 5xx). */
export class ServerError extends Error {
  constructor() {
    super("The server isn't responding.");
    this.name = "ServerError";
  }
}

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
    throw new ServerError();
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`[api] ${res.status} ${url}`, text);
    if (res.status >= 500) {
      throw new ServerError();
    }
    const err = parseErrorJson(text);
    throw new ApiError(err?.message ?? `API error ${res.status}`, err?.type, err?.retryable);
  }

  const text = await res.text();
  console.log(`[api] 200 ${url}`, text);
  return JSON.parse(text) as T;
}

function parseErrorJson(text: string): { message?: string; type?: string; retryable?: boolean } | null {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; type?: string; retryable?: boolean } };
    return parsed?.error ?? null;
  } catch {
    return null;
  }
}

/** prepare: backend fetches UTXOs + builds the unsigned template the wallet signs. */
export function deployPrepare(req: DeployPrepareRequest): Promise<DeployPrepareResult> {
  return apiFetch<DeployPrepareResult>("/v1/events/deploy/prepare", req);
}

/** finalize: backend merges the signature, broadcasts, confirms, and registers. */
export function deployFinalize(req: {
  deploy_id: string;
  template: WireTransaction;
  signed: unknown;
}): Promise<{ covenant_id: string; deploy_txid: string }> {
  return apiFetch<{ covenant_id: string; deploy_txid: string }>("/v1/events/deploy/finalize", req);
}

export interface BuyPrepareResult {
  /** Correlation id echoed back on finalize so the backend can spot abandoned buys. */
  buy_id: string;
  signing_template: string;
  template: WireTransaction;
  sign_inputs: { index: number }[];
  price: number;
}

/** prepare: backend verifies the event + fetches the buyer's UTXOs + builds the template. */
export function buyPrepare(
  covenantId: string,
  req: { publicKey: string; address: string },
): Promise<BuyPrepareResult> {
  return apiFetch<BuyPrepareResult>(`/v1/events/${covenantId}/buy/prepare`, req);
}

/** finalize: backend merges, broadcasts, and waits for confirmation. */
export function buyFinalize(
  covenantId: string,
  req: { buy_id: string; template: WireTransaction; signed: unknown },
): Promise<{ txid: string }> {
  return apiFetch<{ txid: string }>(`/v1/events/${covenantId}/buy/finalize`, req);
}

/** Fetch event detail + raw chain facts from the API (KTK-89: chain-verified). */
export interface EventDetail {
  event: {
    covenant_id: string;
    deploy_txid: string;
    name: string;
    date: string;
    time: string;
    price: number;
    capacity: number;
    organizer_address: string;
    verified: boolean;
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
    throw new ServerError();
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`[api] ${res.status} ${path}`, text);
    if (res.status >= 500) {
      throw new ServerError();
    }
    const err = parseErrorJson(text);
    throw new ApiError(err?.message ?? `API error ${res.status}`, err?.type, err?.retryable);
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
  name: string;
  date: string;
  time: string;
  price: number;
  capacity: number;
  verified: boolean;
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
  event_time: string;
  /** Present only when the ticket is currently listed for resale. */
  listed?: true;
  /** Asking price in sompi — only on listed entries. */
  price?: number;
}

/** Fetch the connected user's on-chain tickets. Confirmation already happened backend-side. */
export function fetchMyTickets(ownerPkh: string): Promise<TicketEntry[]> {
  return apiGet<TicketEntry[]>(`/v1/tickets?owner_pkh=${encodeURIComponent(ownerPkh)}`);
}

export interface UsePrepareResult {
  /** Correlation id stored in the QR — a fresh prepare invalidates prior QRs. */
  use_id: string;
  signing_template: string;
  /** The unsigned mark_used template the owner pre-signs. */
  template: WireTransaction;
  /** Inputs the owner signs: the ticket (0) + fee UTXOs (1..). */
  sign_inputs_owner: { index: number }[];
  /** Verified event facts for the wallet dialog. */
  event: { name: string; date: string };
}

/** prepare: backend verifies the ticket is owned + builds the mark_used template. */
export function usePrepare(
  ticketId: string,
  req: { publicKey: string; address: string },
): Promise<UsePrepareResult> {
  return apiFetch<UsePrepareResult>(`/v1/tickets/${encodeURIComponent(ticketId)}/use/prepare`, req);
}

/** sign-template: the gate re-derives the signing template from the template's chain facts. */
export function useSignTemplate(
  ticketId: string,
  template: WireTransaction,
): Promise<{ signing_template: string }> {
  return apiFetch<{ signing_template: string }>(
    `/v1/tickets/${encodeURIComponent(ticketId)}/use/sign-template`,
    { template },
  );
}

/** finalize: the gate relays both signatures; the backend assembles + broadcasts. */
export function useFinalize(
  ticketId: string,
  req: { use_id: string; template: WireTransaction; owner_signed: unknown; gate_signed: unknown },
): Promise<{ txid: string }> {
  return apiFetch<{ txid: string }>(
    `/v1/tickets/${encodeURIComponent(ticketId)}/use/finalize`,
    req,
  );
}

// --- resale (KTK-151) ---------------------------------------------------------

/** A chain-proven resale listing as served by the directory. */
export interface ListingSummary {
  ticket_id: string;
  price: number;
  seller_pkh: string;
  event_name: string;
  event_date: string;
  covenant_id: string;
  verified: true;
}

/** Live listings for one event — every row is proven on-chain before serving. */
export function fetchEventListings(covenantId: string): Promise<ListingSummary[]> {
  return apiGet<ListingSummary[]>(`/v1/events/${encodeURIComponent(covenantId)}/listings`);
}

export interface ListPrepareResult {
  list_id: string;
  signing_template: string;
  template: WireTransaction;
  sign_inputs: { index: number }[];
  price: number;
  event: { name: string; date: string };
}

/** prepare: backend proves ownership and builds the list template. */
export function listPrepare(
  ticketId: string,
  req: { publicKey: string; address: string; price: number },
): Promise<ListPrepareResult> {
  return apiFetch<ListPrepareResult>(
    `/v1/tickets/${encodeURIComponent(ticketId)}/list/prepare`,
    req,
  );
}

export interface DelistPrepareResult {
  delist_id: string;
  signing_template: string;
  template: WireTransaction;
  sign_inputs: { index: number }[];
  event: { name: string; date: string };
}

/** prepare: backend proves the caller owns the listing and builds the delist. */
export function delistPrepare(
  ticketId: string,
  req: { publicKey: string; address: string },
): Promise<DelistPrepareResult> {
  return apiFetch<DelistPrepareResult>(
    `/v1/tickets/${encodeURIComponent(ticketId)}/delist/prepare`,
    req,
  );
}

export interface PurchasePrepareResult {
  purchase_id: string;
  signing_template: string;
  template: WireTransaction;
  /** Only the buyer's fee inputs need signatures — input 0 is signatureless. */
  sign_inputs: { index: number }[];
  price: number;
  seller_pkh: string;
  event: { name: string; date: string };
}

/** prepare: backend proves the listing on-chain and builds the purchase escrow. */
export function purchasePrepare(
  ticketId: string,
  req: { publicKey: string; address: string },
): Promise<PurchasePrepareResult> {
  return apiFetch<PurchasePrepareResult>(
    `/v1/tickets/${encodeURIComponent(ticketId)}/purchase/prepare`,
    req,
  );
}

/** finalize: backend merges, broadcasts, confirms, and updates the index. */
function resaleFinalize(
  kind: "list" | "delist" | "purchase",
  ticketId: string,
  req: { template: WireTransaction; signed: unknown; price?: number },
): Promise<{ txid: string }> {
  return apiFetch<{ txid: string }>(
    `/v1/tickets/${encodeURIComponent(ticketId)}/${kind}/finalize`,
    req,
  );
}

export const listFinalize = (
  ticketId: string,
  req: { template: WireTransaction; signed: unknown; price: number },
): Promise<{ txid: string }> => resaleFinalize("list", ticketId, req);

export const delistFinalize = (
  ticketId: string,
  req: { template: WireTransaction; signed: unknown },
): Promise<{ txid: string }> => resaleFinalize("delist", ticketId, req);

export const purchaseFinalize = (
  ticketId: string,
  req: { template: WireTransaction; signed: unknown },
): Promise<{ txid: string }> => resaleFinalize("purchase", ticketId, req);
