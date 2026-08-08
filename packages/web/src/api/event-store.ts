import { organizerPkh } from "./crypto";

const STORAGE_KEY = "kticket.events";

export interface StoredEvent {
  eventId: string;
  genesisTxId: string;
  orgPkh: string;
  name: string;
  date: string;
  time: string;
  capacity: number;
  price: number;
  createdAt: number;
}

export function loadEvents(): StoredEvent[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredEvent);
  } catch {
    return [];
  }
}

function isStoredEvent(value: unknown): value is StoredEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.eventId === "string" &&
    typeof event.genesisTxId === "string" &&
    typeof event.orgPkh === "string" &&
    typeof event.name === "string" &&
    typeof event.date === "string" &&
    typeof event.time === "string" &&
    typeof event.capacity === "number" &&
    typeof event.price === "number"
  );
}

export function saveEvent(event: StoredEvent): void {
  const events = loadEvents();
  const next = events.some((e) => e.eventId === event.eventId)
    ? events.map((e) => (e.eventId === event.eventId ? event : e))
    : [...events, event];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function isMine(event: StoredEvent, publicKey: string): boolean {
  return event.orgPkh === organizerPkh(publicKey);
}
