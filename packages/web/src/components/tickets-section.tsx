import { type TicketEntry } from "../api/client";
import { whenLabel } from "../lib/format";

function TicketCard({ ticket }: { ticket: TicketEntry }) {
  return (
    <div className="ticket">
      <div className="ticket-main">
        <h3 className="ticket-name">{ticket.event_name}</h3>
        <p className="ticket-line">{whenLabel(ticket.event_date, ticket.event_time || undefined)}</p>
        <div className="ticket-line-price" />
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

export interface TicketsSectionProps {
  tickets: TicketEntry[];
}

export function TicketsSection({ tickets }: TicketsSectionProps) {
  const grouped = groupByEvent(tickets);

  return (
    <div className="ticket-group-list section-gap">
      {grouped.map(({ eventName, eventTickets }) => (
        <div key={eventTickets[0]?.covenant_id ?? eventName}>
          <h3 className="ticket-group-heading">
            {eventName} &middot; {eventTickets.length}{" "}
            {eventTickets.length === 1 ? "ticket" : "tickets"}
          </h3>
          <div className="ticket-group">
            {eventTickets.map((ticket) => (
              <TicketCard key={ticket.ticket_id} ticket={ticket} />
            ))}
          </div>
        </div>
      ))}
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
