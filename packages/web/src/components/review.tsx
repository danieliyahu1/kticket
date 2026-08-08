import type { EventFormData } from "../components/event-form";

export interface ReviewProps {
  data: EventFormData;
  onDeploy: () => void;
  onEdit: () => void;
}

export function Review({ data, onDeploy, onEdit }: ReviewProps) {
  const priceDisplay = data.price === 0 ? "Free" : `${data.price} KAS`;

  return (
    <section>
      <h2>Review</h2>
      <p>{data.name}</p>
      <p>
        {data.date} at {data.time}
      </p>
      <p>Capacity: {data.capacity}</p>
      <p>Price: {priceDisplay}</p>
      <button type="button" onClick={onDeploy}>
        Deploy
      </button>
      <button type="button" onClick={onEdit}>
        Keep editing
      </button>
    </section>
  );
}
