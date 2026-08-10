import { useCallback, useState } from "react";
import { useWallet } from "../hooks/use-wallet";
import { type TicketEntry } from "../api/client";
import { executeTransfer, type TransferState } from "../api/transfer-machine";
import { whenLabel } from "../lib/format";

function TicketCard({ ticket, onTransfer }: { ticket: TicketEntry; onTransfer: () => void }) {
  return (
    <div className="ticket">
      <div className="ticket-main">
        <h3 className="ticket-name">{ticket.event_name}</h3>
        <p className="ticket-line">{whenLabel(ticket.event_date)}</p>
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
        <button type="button" className="btn btn-link btn-sm btn-link-clean" onClick={onTransfer}>
          Transfer
        </button>
      </div>
    </div>
  );
}

function TransferOverlay({
  ticket,
  state,
  onConfirm,
  onCancel,
}: {
  ticket: TicketEntry;
  state: TransferState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (state.phase === "idle") return null;

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="card overlay-card" onClick={(e) => e.stopPropagation()}>
        {state.phase === "confirm" ? (
          <>
            <p className="modal-heading">Transfer this ticket?</p>
            <p className="modal-sub">
              {ticket.event_name} &middot; {whenLabel(ticket.event_date)}
            </p>
            <p className="modal-sub">This is one-way and cannot be undone.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm}>Transfer</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
            </div>
          </>
        ) : state.phase === "building" || state.phase === "broadcasting" ? (
          <div className="status-progress">
            <div className="spinner" />
            <p className="status-copy">
              {state.phase === "building" ? "Building transfer..." : "Sending to Kaspa..."}
            </p>
          </div>
        ) : state.phase === "success" ? (
          <>
            <div className="status-icon status-icon-ok">
              <span>&#10003;</span>
            </div>
            <p className="modal-heading">Transferred.</p>
            <button type="button" className="btn btn-secondary btn-sm modal-actions" onClick={onCancel}>
              Close
            </button>
          </>
        ) : state.phase === "error" ? (
          <>
            <div className="status-icon status-icon-error">
              <span>&#10007;</span>
            </div>
            <p className="modal-heading">{state.message}</p>
            <button type="button" className="btn btn-secondary btn-sm modal-actions" onClick={onCancel}>
              Close
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function TicketsSection({ tickets, onRefetch }: { tickets: TicketEntry[]; onRefetch: () => Promise<void> }) {
  const { state } = useWallet();
  const [transferState, setTransferState] = useState<TransferState>({ phase: "idle" });
  const [transferTicket, setTransferTicket] = useState<TicketEntry | null>(null);

  const handleTransfer = useCallback((ticket: TicketEntry) => {
    setTransferTicket(ticket);
    setTransferState({ phase: "confirm", ticket });
  }, []);

  const handleTransferConfirm = useCallback(async () => {
    if (!transferTicket || state.status !== "connected" || !state.accounts[0]) return;
    await executeTransfer(setTransferState, {
      ticket: transferTicket,
      publicKey: state.publicKey,
      address: state.accounts[0],
    });
    await onRefetch();
  }, [transferTicket, state, onRefetch]);

  const handleTransferCancel = useCallback(() => {
    setTransferState({ phase: "idle" });
    setTransferTicket(null);
  }, []);

  if (tickets.length === 0) return null;

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
              <TicketCard key={ticket.ticket_id} ticket={ticket} onTransfer={() => handleTransfer(ticket)} />
            ))}
          </div>
        </div>
      ))}
      {transferTicket && (
        <TransferOverlay
          ticket={transferTicket}
          state={transferState}
          onConfirm={handleTransferConfirm}
          onCancel={handleTransferCancel}
        />
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
