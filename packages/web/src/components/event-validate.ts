export interface EventFormData {
  name: string;
  date: string;
  time: string;
  capacity: number;
  price: number;
}

const MAX_CAPACITY = 100;

export function validate(data: EventFormData): Partial<Record<keyof EventFormData, string>> {
  const errors: Partial<Record<keyof EventFormData, string>> = {};
  if (!data.name.trim()) errors.name = "Name is required";
  if (!data.date) errors.date = "Date is required";
  if (!data.time) errors.time = "Time is required";
  if (!Number.isInteger(data.capacity) || data.capacity < 0 || data.capacity > MAX_CAPACITY) {
    errors.capacity = `Capacity must be 0–${MAX_CAPACITY}`;
  }
  if (typeof data.price !== "number" || data.price < 0 || !Number.isFinite(data.price)) {
    errors.price = "Price must be 0 or greater";
  }
  return errors;
}
