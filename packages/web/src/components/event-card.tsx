import { Link } from "react-router-dom";
import type { EventListItem } from "../api/client";
import { priceLabel, shortAddress, whenLabel } from "../lib/format";

export function EventCard({ event }: { event: EventListItem }) {
  return (
    <Link to={`/events/${event.covenant_id}`} className="card event-card">
      <span className="event-card-name">{event.name}</span>
      <span className="event-card-when">{whenLabel(event.date, event.time || undefined)}</span>
      <span className="event-card-price">{priceLabel(event.price)}</span>
      <span className="event-card-organizer">by {shortAddress(event.organizer_address)}</span>
    </Link>
  );
}
