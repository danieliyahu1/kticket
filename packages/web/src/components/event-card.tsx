import { Link } from "react-router-dom";
import type { EventListItem } from "../api/client";
import { shortAddress } from "../lib/format";

export function EventCard({ event }: { event: EventListItem }) {
  return (
    <Link to={`/events/${event.covenant_id}`} className="card event-card">
      <span className="event-card-name">{shortAddress(event.covenant_id)}</span>
      <span className="event-card-organizer">by {shortAddress(event.organizer_address)}</span>
    </Link>
  );
}
