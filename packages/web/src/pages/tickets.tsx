import { useCallback, useEffect, useState } from "react";
import { useWallet } from "../hooks/use-wallet";
import {
  fetchMyTickets,
  ServerError,
  type TicketEntry,
  type UsePrepareResult,
} from "../api/client";
import { prepareCheckIn, signCheckIn, type CheckInState } from "../api/use-machine";
import { executeDelist, executeList, type ResaleState } from "../api/resale-machine";
import { priceLabel, whenLabel } from "../lib/format";
import { Empty, OfflineEmpty } from "../components/empty";
import { QrCode } from "../components/qr-code";

/** The sell dialog collects KAS; the backend wants sompi. */
function kasToSompi(input: string): number | null {
  const value = Number.parseFloat(input);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100_000_000);
}

const RESALE_PHASE_COPY: Record<Exclude<ResaleState["phase"], "idle" | "error">, string> = {
  loading: "Talking to the server…",
  building: "Confirming in your wallet…",
  broadcasting: "Putting it on the chain…",
  success: "",
};

function TicketCard({ ticket, onChanged }: { ticket: TicketEntry; onChanged: () => void }) {
  const { state } = useWallet();
  const [checkIn, setCheckIn] = useState<CheckInState>({ phase: "idle" });
  const [prepared, setPrepared] = useState<UsePrepareResult | null>(null);
  const [resale, setResale] = useState<ResaleState>({ phase: "idle" });
  const [sellOpen, setSellOpen] = useState(false);
  const [priceInput, setPriceInput] = useState("");
  const connected = state.status === "connected";
  const busy = checkIn.phase === "preparing" || checkIn.phase === "signing";
  const resaleBusy =
    resale.phase === "loading" || resale.phase === "building" || resale.phase === "broadcasting";

  const handleCheckIn = useCallback(async () => {
    if (state.status !== "connected" || !state.accounts[0]) return;
    const result = await prepareCheckIn(setCheckIn, {
      ticketId: ticket.ticket_id,
      publicKey: state.publicKey,
      address: state.accounts[0],
    });
    if (result) setPrepared(result);
  }, [state, ticket.ticket_id]);

  const handleApprove = useCallback(async () => {
    if (!prepared) return;
    // Close the dialog on approval — the outcome (QR or error) renders in the
    // card itself, so the wallet prompt is the only blocking layer.
    setPrepared(null);
    await signCheckIn(setCheckIn, prepared);
  }, [prepared]);

  const handleCancel = useCallback(() => {
    setPrepared(null);
    if (checkIn.phase === "idle") return;
    setCheckIn({ phase: "idle" });
  }, [checkIn.phase]);

  const runResale = useCallback(
    async (run: (setState: (s: ResaleState) => void) => Promise<void>) => {
      if (state.status !== "connected" || !state.accounts[0]) return;
      await run(setResale);
      onChanged();
    },
    [state, onChanged],
  );

  const handleSell = useCallback(() => {
    const sompi = kasToSompi(priceInput);
    if (!sompi || state.status !== "connected" || !state.accounts[0]) return;
    const publicKey = state.publicKey;
    const address = state.accounts[0];
    void runResale((set) =>
      executeList(set, {
        ticketId: ticket.ticket_id,
        publicKey,
        address,
        priceSompi: sompi,
      }),
    );
  }, [priceInput, state, ticket.ticket_id, runResale]);

  const handleCancelSale = useCallback(() => {
    if (state.status !== "connected" || !state.accounts[0]) return;
    const publicKey = state.publicKey;
    const address = state.accounts[0];
    void runResale((set) =>
      executeDelist(set, {
        ticketId: ticket.ticket_id,
        publicKey,
        address,
      }),
    );
  }, [state, ticket.ticket_id, runResale]);

  const closeSell = useCallback(() => {
    setSellOpen(false);
    setPriceInput("");
    if (resale.phase !== "idle") setResale({ phase: "idle" });
  }, [resale.phase]);

  return (
    <div className="ticket">
      <div className="ticket-main">
        <h3 className="ticket-name">{ticket.event_name}</h3>
        <p className="ticket-line">{whenLabel(ticket.event_date, ticket.event_time || undefined)}</p>

        {ticket.listed && (
          <p className="ticket-line">
            <span className="badge badge-ok">For sale &middot; {priceLabel(ticket.price ?? 0)}</span>
          </p>
        )}

        {checkIn.phase === "idle" && connected && (
          <>
            <button
              type="button"
              className="button button-secondary button-sm ticket-checkin"
              onClick={handleCheckIn}
            >
              Check in
            </button>
            {ticket.listed && (
              <p className="checkin-copy">Checking in ends your sale.</p>
            )}
            {!ticket.listed && !sellOpen && (
              <button
                type="button"
                className="button button-link button-sm"
                onClick={() => setSellOpen(true)}
                disabled={busy}
              >
                Sell…
              </button>
            )}
          </>
        )}

        {ticket.listed && connected && !resaleBusy && resale.phase !== "success" && (
          <button
            type="button"
            className="button button-secondary button-sm ticket-checkin"
            onClick={handleCancelSale}
          >
            Cancel resale
          </button>
        )}

        {checkIn.phase === "preparing" && (
          <div className="checkin-status" role="status">
            <div className="spinner spinner-sm" />
            <span>Preparing check-in…</span>
          </div>
        )}

        {checkIn.phase === "signing" && (
          <div className="checkin-status" role="status">
            <div className="spinner spinner-sm" />
            <span>Confirming in your wallet…</span>
          </div>
        )}

        {checkIn.phase === "error" && (
          <div className="checkin-error" role="alert">
            <p>{checkIn.message}</p>
            <button
              type="button"
              className="button button-link button-sm"
              onClick={() => {
                setCheckIn({ phase: "idle" });
                setPrepared(null);
              }}
            >
              Try again
            </button>
          </div>
        )}

        {checkIn.phase === "ready" && (
          <div className="checkin-ready" role="status">
            <QrCode value={checkIn.qr} alt={`Check-in QR for ${ticket.event_name}`} />
            <p className="checkin-copy">Show this at the door.</p>
            <button
              type="button"
              className="button button-link button-sm"
              onClick={() => setCheckIn({ phase: "idle" })}
            >
              Done
            </button>
          </div>
        )}

        {resale.phase !== "idle" &&
          resale.phase !== "error" &&
          RESALE_PHASE_COPY[resale.phase] && (
            <div className="checkin-status" role="status">
              <div className="spinner spinner-sm" />
              <span>{RESALE_PHASE_COPY[resale.phase]}</span>
            </div>
          )}

        {resale.phase === "success" && (
          <p className="checkin-copy" role="status">
            {ticket.listed ? "Your listing is live." : "Sale cancelled."}
          </p>
        )}

        {resale.phase === "error" && (
          <div className="checkin-error" role="alert">
            <p>{resale.message}</p>
            <button
              type="button"
              className="button button-link button-sm"
              onClick={() => setResale({ phase: "idle" })}
            >
              Try again
            </button>
          </div>
        )}
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

      {(prepared || sellOpen) && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={sellOpen ? "Sell ticket" : "Check in"}>
          <div className="dialog">
            {sellOpen ? (
              <>
                <h3 className="dialog-title">Sell your ticket to {ticket.event_name}?</h3>
                <p className="dialog-copy">
                  Your ticket goes into covenant escrow. Anyone can buy it at this exact price — no
                  trust needed.
                </p>
                <label className="field">
                  <span className="field-label">Asking price (KAS)</span>
                  <input
                    className="input mono"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="1.5"
                    value={priceInput}
                    autoFocus
                    onChange={(e) => setPriceInput(e.target.value)}
                    disabled={resaleBusy}
                  />
                </label>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={closeSell}
                    disabled={resaleBusy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={handleSell}
                    disabled={resaleBusy || !kasToSompi(priceInput)}
                  >
                    List for sale
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="dialog-title">Hand over your ticket to {ticket.event_name}?</h3>
                <p className="dialog-copy">
                  Approve to pre-sign your check-in. Nothing is spent — you get a QR the gate can
                  scan.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={handleCancel}
                    disabled={busy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={handleApprove}
                    disabled={busy}
                  >
                    Approve
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
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

function TicketsSection({ tickets, onChanged }: { tickets: TicketEntry[]; onChanged: () => void }) {
  return (
    <div className="ticket-group-list">
      {groupByEvent(tickets).map(({ eventName, eventTickets }) => (
        <div key={eventTickets[0]?.covenant_id ?? eventName}>
          <h3 className="ticket-group-heading">
            {eventName} &middot; {eventTickets.length} {eventTickets.length === 1 ? "ticket" : "tickets"}
          </h3>
          {eventTickets.map((ticket) => (
            <TicketCard key={ticket.ticket_id} ticket={ticket} onChanged={onChanged} />
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
        <TicketsSection tickets={tickets} onChanged={load} />
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
