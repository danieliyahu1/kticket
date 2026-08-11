export const WHEN_FORMAT = {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
} as const;

/** Date-only formatter — used when an event has no start time (legacy deploys). */
export const WHEN_DATE_ONLY_FORMAT = {
  weekday: "long",
  month: "long",
  day: "numeric",
} as const;

/**
 * Format an event's start date (+ optional local wall-clock time).
 * Without a time, renders the date only — never invents a time-of-day.
 */
export function whenLabel(date: string, time?: string): string {
  if (!date) return "";
  if (time) {
    const dt = new Date(`${date}T${time}`);
    return new Intl.DateTimeFormat("en", WHEN_FORMAT).format(dt);
  }
  return new Intl.DateTimeFormat("en", WHEN_DATE_ONLY_FORMAT).format(new Date(`${date}T12:00:00`));
}

export function priceLabel(price: number): string {
  if (price === 0) return "Free";
  const kas = price >= 100000000 ? price / 100000000 : price;
  return `${kas} KAS`;
}

export function capacityLabel(capacity: number): string {
  return `${capacity} ${capacity === 1 ? "ticket" : "tickets"}`;
}

/** Shorten a bech32 address for display: `kaspatest:qpz…mua7l`. */
export function shortAddress(address: string): string {
  if (address.length <= 24) return address;
  const sep = address.indexOf(":");
  const prefix = sep >= 0 ? address.slice(0, sep + 1) : "";
  const body = sep >= 0 ? address.slice(sep + 1) : address;
  if (body.length <= 20) return address;
  return `${prefix}${body.slice(0, 9)}…${body.slice(-6)}`;
}
