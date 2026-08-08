import type { EventFormData } from "./event-form";
import { capacityLabel, priceLabel, whenLabel } from "../lib/format";

export interface ReviewProps {
  data: EventFormData;
  onDeploy: () => void;
  onEdit: () => void;
}

export function Review({ data, onDeploy, onEdit }: ReviewProps) {
  return (
    <section>
      <div className="ticket">
        <div className="ticket-main">
          <p className="stub-label">Event</p>
          <h2 className="ticket-name">{data.name}</h2>
          <p className="ticket-line">{whenLabel(data.date, data.time)}</p>
        </div>
        <div className="ticket-perforation" aria-hidden="true" />
        <div className="ticket-stub">
          <div className="stub-item">
            <span className="stub-label">Price</span>
            <span className="stub-value">{priceLabel(data.price)}</span>
          </div>
          <div className="stub-item">
            <span className="stub-label">Capacity</span>
            <span className="stub-value">{capacityLabel(data.capacity)}</span>
          </div>
          <div className="stub-item">
            <span className="stub-label">Admission</span>
            <span className="stub-value">Admit one</span>
          </div>
        </div>
      </div>
      <div className="ticket-actions">
        <button type="button" className="btn btn-primary" onClick={onDeploy}>
          Deploy event
        </button>
        <button type="button" className="btn btn-link" onClick={onEdit}>
          Keep editing
        </button>
      </div>
      <p className="note">
        Once deployed, this event is on the chain forever. It can't be edited or cancelled.
      </p>
    </section>
  );
}
