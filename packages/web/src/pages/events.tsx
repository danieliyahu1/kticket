import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetchEventsList, fetchMyTicketsWithRetry, type EventListItem, type TicketEntry } from "../api/client";
import { organizerPkh } from "../api/crypto";
import { Empty } from "../components/empty";
import { TicketsSection } from "../components/tickets-section";
import { useWallet } from "../hooks/use-wallet";
import { priceLabel, whenLabel } from "../lib/format";

type Segment = "all" | "created" | "tickets";

const SEGMENTS: Array<{ id: Segment; label: string }> = [
  { id: "all", label: "Browse" },
  { id: "created", label: "Created" },
  { id: "tickets", label: "Tickets" },
];

function hashHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function BrowseEmpty() {
  return (
    <Empty
      title="Nothing on the chain yet."
      sub="Be the first — put an event on Kaspa."
      actionLabel="Create an event"
      actionTo="/create"
    />
  );
}

function CreatedEmptyConnected() {
  return (
    <Empty
      title="Nothing here yet."
      sub="Create your first event on Kaspa."
      actionLabel="Create an event"
      actionTo="/create"
    />
  );
}

function CreatedEmptyDisconnected({ onConnect }: { onConnect: () => void }) {
  return (
    <Empty
      title="Events you created live here."
      sub="Connect your wallet to see them."
      actionLabel="Connect wallet"
      onAction={onConnect}
    />
  );
}

function TicketsEmptyConnected() {
  return (
    <Empty
      title="No tickets yet."
      sub="Find an event and grab a ticket."
      actionLabel="Browse events"
      actionTo="/"
    />
  );
}

function TicketsEmptyDisconnected({ onConnect }: { onConnect: () => void }) {
  return (
    <Empty
      title="Tickets you hold live here."
      sub="Connect your wallet to see them."
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

const HERO: Record<Segment, { title: string; sub: string }> = {
  all: {
    title: "Real tickets. On the chain.",
    sub: "Tickets that can't be faked, duplicated, or taken from you.",
  },
  created: {
    title: "Events you've put on the chain.",
    sub: "Bring people together — on Kaspa.",
  },
  tickets: {
    title: "Tickets you hold.",
    sub: "Your passes to everything you've signed up for.",
  },
};

function segmentFromParam(param: string | null): Segment {
  if (param === "created") return "created";
  if (param === "tickets") return "tickets";
  return "all";
}

function paramFromSegment(segment: Segment): string | null {
  if (segment === "all") return null;
  return segment;
}

export default function EventsPage() {
  const { state, connect } = useWallet();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialSegment = segmentFromParam(searchParams.get("filter"));
  const [segment, setSegment] = useState<Segment>(initialSegment);
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [tickets, setTickets] = useState<TicketEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const connected = state.status === "connected";
  const filterOrgPkh =
    segment === "created" && connected ? organizerPkh(state.publicKey) : undefined;

  const loadTickets = useCallback(async () => {
    if (state.status !== "connected") return;
    try {
      const list = await fetchMyTicketsWithRetry(state.publicKey);
      setTickets(list);
    } catch {
      setTickets([]);
    }
  }, [state.status, state.status === "connected" ? state.publicKey : undefined]);

  useEffect(() => {
    if (segment === "tickets") {
      if (connected) {
        loadTickets();
      }
      setLoading(false);
      setEvents([]);
      return;
    }

    if (segment === "created" && !connected) {
      setLoading(false);
      setEvents([]);
      return;
    }

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
  }, [filterOrgPkh, segment]);

  const visible = events;

  return (
    <section>
      <div className="hero">
        <h1 className="hero-title">{HERO[segment].title}</h1>
        <p className="hero-sub">{HERO[segment].sub}</p>
      </div>
      <Segmented
        current={segment}
        onChange={(s) => {
          setSegment(s);
          const param = paramFromSegment(s);
          if (param) {
            setSearchParams({ filter: param });
          } else {
            setSearchParams({});
          }
        }}
      />
      {segment === "tickets" ? (
        connected ? (
          <TicketsSection tickets={tickets} onRefetch={loadTickets} />
        ) : (
          <TicketsEmptyDisconnected onConnect={connect} />
        )
      ) : loading ? (
        <div className="event-list">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton skeleton-card" aria-hidden="true" />
          ))}
        </div>
      ) : visible.length > 0 ? (
        <div className="event-list">
          {visible.map((event) => (
            <EventCard key={event.covenant_id} event={event} />
          ))}
        </div>
      ) : segment === "created" ? (
        connected ? (
          <CreatedEmptyConnected />
        ) : (
          <CreatedEmptyDisconnected onConnect={connect} />
        )
      ) : (
        <BrowseEmpty />
      )}
    </section>
  );
}
