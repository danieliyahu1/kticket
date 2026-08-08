import type { EventFormData } from "./event-validate";

export type { EventFormData };

const MAX_CAPACITY = 100;

function toNum(v: string): number {
  return Number(v);
}

interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}

function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface EventFormProps {
  initial: EventFormData;
  onSubmit: (data: EventFormData) => void;
  errors: Partial<Record<keyof EventFormData, string>>;
  onChange: (data: EventFormData) => void;
}

function NameField({ initial, errors, onChange }: EventFormProps) {
  return (
    <Field label="Event name" htmlFor="event-name" error={errors.name}>
      <input
        id="event-name"
        className="input"
        type="text"
        placeholder="e.g. Night in the Garden"
        value={initial.name}
        onChange={(e) => onChange({ ...initial, name: e.target.value })}
        aria-invalid={errors.name ? true : undefined}
        required
      />
    </Field>
  );
}

function WhenField({ initial, errors, onChange }: EventFormProps) {
  return (
    <div className="field-row">
      <Field label="Date" htmlFor="event-date" error={errors.date}>
        <input
          id="event-date"
          className="input"
          type="date"
          value={initial.date}
          onChange={(e) => onChange({ ...initial, date: e.target.value })}
          aria-invalid={errors.date ? true : undefined}
          required
        />
      </Field>
      <Field label="Time" htmlFor="event-time" error={errors.time}>
        <input
          id="event-time"
          className="input"
          type="time"
          value={initial.time}
          onChange={(e) => onChange({ ...initial, time: e.target.value })}
          aria-invalid={errors.time ? true : undefined}
          required
        />
      </Field>
    </div>
  );
}

function CapacityField({ initial, errors, onChange }: EventFormProps) {
  return (
    <Field
      label="Capacity"
      htmlFor="event-capacity"
      hint="How many tickets to sell — up to 100."
      error={errors.capacity}
    >
      <input
        id="event-capacity"
        className="input"
        type="number"
        min={0}
        max={MAX_CAPACITY}
        value={initial.capacity}
        onChange={(e) => onChange({ ...initial, capacity: toNum(e.target.value) })}
        aria-invalid={errors.capacity ? true : undefined}
        required
      />
    </Field>
  );
}

function PriceField({ initial, errors, onChange }: EventFormProps) {
  return (
    <Field
      label="Price"
      htmlFor="event-price"
      hint="In KAS. Set to 0 for a free event."
      error={errors.price}
    >
      <input
        id="event-price"
        className="input"
        type="number"
        min={0}
        step="any"
        value={initial.price}
        onChange={(e) => onChange({ ...initial, price: toNum(e.target.value) })}
        aria-invalid={errors.price ? true : undefined}
        required
      />
    </Field>
  );
}

export function EventForm({ initial, onSubmit, errors, onChange }: EventFormProps) {
  const p = { initial, onSubmit, errors, onChange };
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(initial);
      }}
    >
      <NameField {...p} />
      <WhenField {...p} />
      <CapacityField {...p} />
      <PriceField {...p} />
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">
          Review
        </button>
      </div>
    </form>
  );
}
