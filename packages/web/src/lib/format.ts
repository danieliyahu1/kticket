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
