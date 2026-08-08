const STORAGE_KEY = "kticket.tickets";

export interface StoredTicket {
  /** The ticket covenant UTXO outpoint — txid:index. */
  ticketId: string;
  /** Genesis txid of the event this ticket belongs to. */
  eventId: string;
  /** Event name. */
  eventName: string;
  /** Event date. */
  eventDate: string;
  /** Event time. */
  eventTime: string;
  /** Ticket price in KAS. */
  price: number;
  /** Transaction id of the buy tx. */
  buyTxId: string;
  /** Organizer's public key hash. */
  orgPkh: string;
  /** When the ticket was acquired (ms epoch). */
  acquiredAt: number;
}

export function loadTickets(): StoredTicket[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredTicket);
  } catch {
    return [];
  }
}

function isStoredTicket(value: unknown): value is StoredTicket {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.ticketId === "string" &&
    typeof t.eventId === "string" &&
    typeof t.eventName === "string" &&
    typeof t.eventDate === "string" &&
    typeof t.eventTime === "string" &&
    typeof t.price === "number" &&
    typeof t.buyTxId === "string" &&
    typeof t.orgPkh === "string"
  );
}

export function saveTicket(ticket: StoredTicket): void {
  const tickets = loadTickets();
  const exists = tickets.some((t) => t.ticketId === ticket.ticketId);
  if (!exists) {
    tickets.push(ticket);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tickets));
}

export function removeTicket(ticketId: string): void {
  const tickets = loadTickets().filter((t) => t.ticketId !== ticketId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tickets));
}

/** Group tickets by event id. */
export function ticketsByEvent(tickets: StoredTicket[]): Map<string, StoredTicket[]> {
  const grouped = new Map<string, StoredTicket[]>();
  for (const t of tickets) {
    const existing = grouped.get(t.eventId);
    if (existing) {
      existing.push(t);
    } else {
      grouped.set(t.eventId, [t]);
    }
  }
  return grouped;
}
