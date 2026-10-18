// Per-event link-preview metadata (KTK-160).
//
// The server renders this into the SPA shell for crawlers and chat clients; the
// web app applies the same values when it navigates inside the SPA. Keeping one
// pure builder here means a fresh load and a client-side navigation cannot
// disagree about the title, description, or canonical URL.
//
// Everything is derived from chain-verified event facts supplied by the caller.
// This module performs no I/O and never invents a value: an absent name falls
// back to the generic site metadata, and an unusable image simply omits the
// image tags.

export interface EventMetaFacts {
  covenant_id: string;
  name: string;
  /** ISO date (`YYYY-MM-DD`) decoded from the verified payload. */
  date: string;
  /** Local wall-clock start (`HH:MM`); empty when the event has no time. */
  time?: string;
  /** Price per ticket in sompi. */
  price: number;
  /** Poster art URI (https:// or ipfs://); empty when absent. */
  image?: string;
}

export interface EventMeta {
  title: string;
  description: string;
  /** Absolute URL of the event page. */
  canonicalUrl: string;
  /** Absolute image URL; absent when the event has no usable image. */
  imageUrl?: string;
  twitterCard: "summary_large_image" | "summary";
}

export const SITE_NAME = "kticket";
export const GENERIC_TITLE = "kticket — tickets on the chain";
export const GENERIC_DESCRIPTION =
  "Tickets on the chain. Create an event on Kaspa and let anyone in who holds a ticket.";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const SOMPI_PER_KAS = 100_000_000;
const MAX_DESCRIPTION_LENGTH = 200;

/** The canonical SPA path for one event. */
export function eventPath(covenantId: string): string {
  return `/events/${encodeURIComponent(covenantId)}`;
}

/** The absolute canonical URL for one event. */
export function eventUrl(origin: string, covenantId: string): string {
  return absoluteUrl(origin, eventPath(covenantId));
}

/** The metadata used by the site itself and by any event without usable facts. */
export function buildGenericMeta(origin: string): EventMeta {
  return {
    title: GENERIC_TITLE,
    description: GENERIC_DESCRIPTION,
    canonicalUrl: absoluteUrl(origin, "/"),
    twitterCard: "summary",
  };
}

/**
 * Build the preview for a verified event. A blank name means there is nothing
 * trustworthy to preview, so the generic site metadata is used instead.
 */
export function buildEventMeta(event: EventMetaFacts, origin: string): EventMeta {
  const name = event.name.trim();
  if (name.length === 0) return buildGenericMeta(origin);

  const when = eventWhenLabel(event.date, event.time);
  const imageUrl = absoluteImage(event.image, origin);

  return {
    title: `${name} — ${SITE_NAME}`,
    description: eventDescription(name, when, event.price),
    canonicalUrl: eventUrl(origin, event.covenant_id),
    ...(imageUrl ? { imageUrl } : {}),
    twitterCard: imageUrl ? "summary_large_image" : "summary",
  };
}

function eventDescription(name: string, when: string, price: number): string {
  const lead = when.length > 0 ? `${name} — ${when}` : name;
  const parts = [lead, ticketPriceSentence(price), "Verified on-chain on Kaspa"].filter(
    (part) => part.length > 0,
  );
  return truncate(`${parts.join(". ")}.`, MAX_DESCRIPTION_LENGTH);
}

function ticketPriceSentence(price: number): string {
  if (price === 0) return "Free entry";
  const label = eventPriceLabel(price);
  return label.length > 0 ? `${label} per ticket` : "";
}

/**
 * Format a verified event's start for human eyes. The formatting is
 * deterministic (no locale database) so the server and the browser agree.
 */
export function eventWhenLabel(date: string, time?: string): string {
  const raw = date.trim();
  const parsed = parseIsoDate(raw);
  if (parsed === null) return raw;

  const dayLabel = `${parsed.day} ${MONTHS[parsed.month - 1]} ${parsed.year}`;
  const clock = parseClock(time);
  return clock === undefined ? dayLabel : `${dayLabel}, ${clock}`;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function parseIsoDate(raw: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const probe = new Date(Date.UTC(year, month - 1, day));
  const isRealDay =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return isRealDay ? { year, month, day } : null;
}

function parseClock(time: string | undefined): string | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time?.trim() ?? "");
  return match === null ? undefined : `${match[1]}:${match[2]}`;
}

/** Format a sompi price as KAS; `Free` when the price is zero. */
export function eventPriceLabel(price: number): string {
  if (!Number.isFinite(price) || price < 0) return "";
  if (price === 0) return "Free";
  const kas = price / SOMPI_PER_KAS;
  const fixed = kas.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return `${fixed} KAS`;
}

function absoluteUrl(origin: string, path: string): string {
  const base = origin.trim().replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Only absolute image URLs can be previewed. IPFS URIs are resolved through a
 * public gateway; relative, data, and malformed values are omitted rather than
 * guessed at.
 */
function absoluteImage(image: string | undefined, origin: string): string | undefined {
  const raw = image?.trim() ?? "";
  if (raw.length === 0) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("ipfs://")) {
    const cid = raw.slice("ipfs://".length).replace(/^ipfs\//, "");
    return cid.length > 0 ? `https://ipfs.io/ipfs/${cid}` : undefined;
  }
  if (raw.startsWith("/")) return absoluteUrl(origin, raw);
  return undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}
