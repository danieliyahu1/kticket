import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isMine, loadEvents, type StoredEvent } from "../api/event-store";
import { useWallet } from "../hooks/use-wallet";

type Segment = "all" | "mine";

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: "all", label: "All events" },
  { id: "mine", label: "My events" },
];

interface EmptyProps {
  title: string;
  sub: string;
  actionLabel: string;
  actionTo?: string;
  onAction?: () => void;
}

function Empty({ title, sub, actionLabel, actionTo, onAction }: EmptyProps) {
  const action = actionTo ? (
    <Link to={actionTo} className="btn btn-primary">
      {actionLabel}
    </Link>
  ) : (
    <button type="button" className="btn btn-primary" onClick={onAction}>
      {actionLabel}
    </button>
  );
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <p className="empty-sub">{sub}</p>
      <div className="empty-actions">{action}</div>
    </div>
  );
}

function AllEmpty() {
  return (
    <Empty
      title="Nothing on the chain yet."
      sub="Be the first — put an event on Kaspa."
      actionLabel="Create an event"
      actionTo="/create"
    />
  );
}

function MineEmpty({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  return connected ? (
    <Empty
      title="Nothing of yours yet."
      sub="Put your first event on Kaspa."
      actionLabel="Create an event"
      actionTo="/create"
    />
  ) : (
    <Empty
      title="Your events live here."
      sub="Connect your wallet to see what's yours."
      actionLabel="Connect wallet"
      onAction={onConnect}
    />
  );
}

function Segmented({ current, onChange }: { current: Segment; onChange: (s: Segment) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Filter events">
      {SEGMENTS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          className={current === id ? "segment segment-active" : "segment"}
          aria-pressed={current === id}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const WHEN_FORMAT = {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
} as const;

function whenLabel(date: string, time: string): string {
  if (!(date && time)) return "";
  return new Intl.DateTimeFormat("en", WHEN_FORMAT).format(new Date(`${date}T${time}`));
}

function priceLabel(price: number): string {
  return price === 0 ? "Free" : `${price} KAS`;
}

function capacityLabel(capacity: number): string {
  return `${capacity} ${capacity === 1 ? "ticket" : "tickets"}`;
}

function EventCard({ event }: { event: StoredEvent }) {
  return (
    <Link to={`/events/${event.eventId}`} className="card event-card" style={{ textDecoration: "none", color: "inherit" }}>
      <h3 className="event-card-name">{event.name}</h3>
      <p className="event-card-line">{whenLabel(event.date, event.time)}</p>
      <div className="event-card-meta">
        <span>{priceLabel(event.price)}</span>
        <span>{capacityLabel(event.capacity)}</span>
      </div>
    </Link>
  );
}

export default function EventsPage() {
  const { state, connect } = useWallet();
  const [segment, setSegment] = useState<Segment>("all");
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const connected = state.status === "connected";

  useEffect(() => {
    setEvents(loadEvents());
  }, []);

  const visible =
    segment === "all"
      ? events
      : state.status === "connected"
        ? events.filter((event) => isMine(event, state.publicKey))
        : [];

  return (
    <section>
      <h2 className="page-heading">Events</h2>
      <Segmented current={segment} onChange={setSegment} />
      {visible.length > 0 ? (
        <div className="event-list">
          {visible.map((event) => (
            <EventCard key={event.eventId} event={event} />
          ))}
        </div>
      ) : segment === "mine" ? (
        <MineEmpty connected={connected} onConnect={connect} />
      ) : (
        <AllEmpty />
      )}
    </section>
  );
}
