import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchEventsList, type EventListItem } from "../api/client";
import { organizerPkh } from "../api/crypto";
import { Empty } from "../components/empty";
import { useWallet } from "../hooks/use-wallet";
import { priceLabel, whenLabel } from "../lib/format";

type Segment = "all" | "mine";

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: "all", label: "All events" },
  { id: "mine", label: "My events" },
];

function hashHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
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
    <div className="segmented" role="group" aria-label="Filter events" style={{ "--seg": SEGMENTS.findIndex((s) => s.id === current) } as React.CSSProperties}>
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

function EventCard({ event }: { event: EventListItem }) {
  return (
    <Link to={`/events/${event.covenant_id}`} className="card event-card">
      <span
        className="event-card-accent"
        style={{ background: `hsl(${hashHue(event.name)}, 45%, 48%)` }}
      />
      <h3 className="event-card-name">{event.name}</h3>
      <p className="event-card-line">
        {priceLabel(event.price)} &middot; {whenLabel(event.date)}
      </p>
    </Link>
  );
}

export default function EventsPage() {
  const { state, connect } = useWallet();
  const [segment, setSegment] = useState<Segment>("all");
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const connected = state.status === "connected";
  const filterOrgPkh =
    segment === "mine" && connected ? organizerPkh(state.publicKey) : undefined;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const list = await fetchEventsList(filterOrgPkh);
        if (!cancelled) setEvents(list);
      } catch {
        if (!cancelled) setEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [filterOrgPkh]);

  const visible = events;

  return (
    <section>
      {segment !== "mine" && (
        <div className="hero">
          <h1 className="hero-title">Real tickets. On the chain.</h1>
          <p className="hero-sub">Tickets that can't be faked, duplicated, or taken from you.</p>
        </div>
      )}
      <Segmented current={segment} onChange={setSegment} />
      {loading ? null : visible.length > 0 ? (
        <div className="event-list">
          {visible.map((event) => (
            <EventCard key={event.covenant_id} event={event} />
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
