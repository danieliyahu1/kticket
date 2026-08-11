import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../hooks/use-wallet";
import { fetchMyTickets, ServerError, type TicketEntry } from "../api/client";
import { whenLabel } from "../lib/format";
import { Empty, OfflineEmpty } from "../components/empty";

function TicketCard({ ticket }: { ticket: TicketEntry }) {
  return (
    <div className="ticket">
      <div className="ticket-main">
        <h3 className="ticket-name">{ticket.event_name}</h3>
        <p className="ticket-line">{whenLabel(ticket.event_date, ticket.event_time || undefined)}</p>
      </div>
      <div className="ticket-perforation" />
      <div className="ticket-stub">
        <div className="stub-item">
          <span className="stub-label">Ticket ID</span>
          <span className="stub-value stub-value-sm mono">
            {ticket.ticket_id.slice(0, 10)}...
          </span>
        </div>
      </div>
    </div>
  );
}

function TicketsEmpty() {
  return (
    <Empty
      title="No tickets yet."
      sub="Find an event and grab a ticket."
      actionLabel="Browse events"
      actionTo="/"
    />
  );
}

function TicketsSection({ tickets }: { tickets: TicketEntry[] }) {
  return (
    <div className="ticket-group-list">
      {groupByEvent(tickets).map(({ eventName, eventTickets }) => (
        <div key={eventTickets[0]?.covenant_id ?? eventName}>
          <h3 className="ticket-group-heading">
            {eventName} &middot; {eventTickets.length} {eventTickets.length === 1 ? "ticket" : "tickets"}
          </h3>
          {eventTickets.map((ticket) => (
            <TicketCard key={ticket.ticket_id} ticket={ticket} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function TicketsPage() {
  const { state, connect } = useWallet();
  const connected = state.status === "connected";
  const [tickets, setTickets] = useState<TicketEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const load = useCallback(async () => {
    if (state.status !== "connected") return;
    setOffline(false);
    setLoading(true);
    try {
      const list = await fetchMyTickets(state.publicKey);
      setTickets(list);
    } catch (err) {
      console.error("[tickets] failed to load", err);
      if (err instanceof ServerError) {
        setOffline(true);
      } else {
        setTickets([]);
      }
    } finally {
      setLoading(false);
    }
  }, [state.status, state.status === "connected" ? state.publicKey : undefined]);

  useEffect(() => {
    if (state.status === "connected") {
      load();
    }
  }, [state.status === "connected" ? state.publicKey : "", load]);

  return (
    <div>
      {!connected ? (
        <Empty
          title="Your tickets live here."
          sub="Connect your wallet to see what's yours."
          actionLabel="Connect wallet"
          onAction={connect}
        />
      ) : offline ? (
        <OfflineEmpty onRetry={() => setRetryKey((k) => k + 1)} />
      ) : loading ? (
        <div className="event-list">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton skeleton-row" aria-hidden="true" />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <TicketsEmpty />
      ) : (
        <TicketsSection tickets={tickets} />
      )}
    </div>
  );
}

function groupByEvent(tickets: TicketEntry[]): { eventName: string; eventTickets: TicketEntry[] }[] {
  const map = new Map<string, TicketEntry[]>();
  for (const t of tickets) {
    const list = map.get(t.covenant_id);
    if (list) {
      list.push(t);
    } else {
      map.set(t.covenant_id, [t]);
    }
  }
  return Array.from(map.entries()).map(([covenantId, eventTickets]) => ({
    eventName: eventTickets[0]?.event_name ?? "",
    eventTickets,
  }));
}
