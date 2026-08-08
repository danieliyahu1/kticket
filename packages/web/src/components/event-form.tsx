import type { EventFormData } from "./event-validate";

export type { EventFormData };

const MAX_CAPACITY = 100;

function toNum(v: string): number {
  return Number(v);
}

interface EventFormProps {
  initial: EventFormData;
  onSubmit: (data: EventFormData) => void;
  errors: Partial<Record<keyof EventFormData, string>>;
  onChange: (data: EventFormData) => void;
}

function NameField({ initial, errors, onChange }: EventFormProps) {
  return (
    <div>
      <label htmlFor="event-name">Event name</label>
      <input
        id="event-name"
        type="text"
        value={initial.name}
        onChange={(e) => onChange({ ...initial, name: e.target.value })}
        required
      />
      {errors.name && <small>{errors.name}</small>}
    </div>
  );
}

function DateField({ initial, errors, onChange }: EventFormProps) {
  return (
    <div>
      <label htmlFor="event-date">Date</label>
      <input
        id="event-date"
        type="date"
        value={initial.date}
        onChange={(e) => onChange({ ...initial, date: e.target.value })}
        required
      />
      {errors.date && <small>{errors.date}</small>}
    </div>
  );
}

function TimeField({ initial, errors, onChange }: EventFormProps) {
  return (
    <div>
      <label htmlFor="event-time">Time</label>
      <input
        id="event-time"
        type="time"
        value={initial.time}
        onChange={(e) => onChange({ ...initial, time: e.target.value })}
        required
      />
      {errors.time && <small>{errors.time}</small>}
    </div>
  );
}

function CapacityField({ initial, errors, onChange }: EventFormProps) {
  return (
    <div>
      <label htmlFor="event-capacity">Capacity</label>
      <input
        id="event-capacity"
        type="number"
        min={0}
        max={MAX_CAPACITY}
        value={initial.capacity}
        onChange={(e) => onChange({ ...initial, capacity: toNum(e.target.value) })}
        required
      />
      <small>Max {MAX_CAPACITY}</small>
      {errors.capacity && <small>{errors.capacity}</small>}
    </div>
  );
}

function PriceField({ initial, errors, onChange }: EventFormProps) {
  return (
    <div>
      <label htmlFor="event-price">Price (KAS)</label>
      <input
        id="event-price"
        type="number"
        min={0}
        step="any"
        value={initial.price}
        onChange={(e) => onChange({ ...initial, price: toNum(e.target.value) })}
        required
      />
      {initial.price === 0 && <small>Free</small>}
      {errors.price && <small>{errors.price}</small>}
    </div>
  );
}

export function EventForm({ initial, onSubmit, errors, onChange }: EventFormProps) {
  const p = { initial, onSubmit, errors, onChange };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(initial);
      }}
    >
      <NameField {...p} />
      <DateField {...p} />
      <TimeField {...p} />
      <CapacityField {...p} />
      <PriceField {...p} />
      <button type="submit">Review</button>
    </form>
  );
}
