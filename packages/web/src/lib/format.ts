export const WHEN_FORMAT = {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
} as const;

export function whenLabel(date: string, time?: string): string {
  if (!date) return "";
  const dt = time ? new Date(`${date}T${time}`) : new Date(date);
  return new Intl.DateTimeFormat("en", WHEN_FORMAT).format(dt);
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
