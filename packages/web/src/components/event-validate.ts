import { MAX_EVENT_CAPACITY, MIN_TICKET_PRICE_KAS } from "@kticket/kit";

export interface EventFormData {
  name: string;
  date: string;
  time: string;
  capacity: number;
  price: number;
}

export function validate(data: EventFormData): Partial<Record<keyof EventFormData, string>> {
  const errors: Partial<Record<keyof EventFormData, string>> = {};
  if (!data.name.trim()) errors.name = "Name is required";
  if (!data.date) errors.date = "Date is required";
  if (!data.time) errors.time = "Time is required";
  if (!Number.isInteger(data.capacity) || data.capacity < 0 || data.capacity > MAX_EVENT_CAPACITY) {
    errors.capacity = `Capacity must be 0–${MAX_EVENT_CAPACITY}`;
  }
  if (
    typeof data.price !== "number" ||
    !Number.isFinite(data.price) ||
    data.price < MIN_TICKET_PRICE_KAS
  ) {
    errors.price = `Price must be at least ${MIN_TICKET_PRICE_KAS} KAS`;
  }
  return errors;
}
