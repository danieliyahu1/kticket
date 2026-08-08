import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  loadTickets,
  removeTicket,
  saveTicket,
  ticketsByEvent,
  type StoredTicket,
} from "../api/ticket-store";
import { useWallet } from "../hooks/use-wallet";
import { broadcastTx, buildTransferTx, fetchEvent, type EventDetail } from "../api/client";
import { organizerPkh } from "../api/crypto";
import { changeScriptFromPublicKey, fetchUtxos, toWireUtxo, toWireUtxoMeta } from "../api/kaspa";
import type { BuildResult, WireOutpoint, WireTransaction } from "../api/types";

const SOMPI_PER_KAS = 100_000_000;

const WHEN_FORMAT = {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
} as const;

function whenLabel(date: string): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("en", WHEN_FORMAT).format(new Date(date));
}

function priceLabel(price: number): string {
  return price === 0 ? "Free" : `${price} KAS`;
}

type TransferState =
  | { phase: "idle" }
  | { phase: "confirm"; ticket: StoredTicket }
  | { phase: "building" }
  | { phase: "broadcasting" }
  | { phase: "success" }
  | { phase: "error"; message: string };

function errorMsg(err: unknown): string {
  if (!(err instanceof Error)) return "Transfer failed.";
  const msg = err.message;
  if (msg === "No connection") return "No connection - transfer can't complete.";
  if (msg.includes("funds") || msg.includes("fee")) return "Not enough funds - transfer didn't go through.";
  return "Transfer failed.";
}

function parseTicketOutpoint(ticketId: string): WireOutpoint {
  const parts = ticketId.split(":");
  return { transaction_id: parts[0] ?? ticketId, index: Number(parts[1] ?? 0) };
}

function TicketCard({ ticket, onTransfer }: { ticket: StoredTicket; onTransfer: () => void }) {
  return (
    <div className="ticket">
      <div className="ticket-main">
        <h3 className="ticket-name">{ticket.eventName}</h3>
        <p className="ticket-line">{whenLabel(ticket.eventDate)}</p>
        <div className="ticket-line" style={{ color: "var(--ink-tertiary)", fontSize: "0.8125rem" }}>
          {priceLabel(ticket.price)}
        </div>
      </div>
      <div className="ticket-perforation" />
      <div className="ticket-stub">
        <div className="stub-item">
          <span className="stub-label">Ticket ID</span>
          <span className="stub-value mono" style={{ fontSize: "0.6875rem" }}>
            {ticket.ticketId.slice(0, 10)}...
          </span>
        </div>
        <button type="button" className="btn btn-link btn-sm" style={{ padding: 0 }} onClick={onTransfer}>
          Transfer
        </button>
      </div>
    </div>
  );
}

function TransferDialog({
  ticket,
  state,
  onConfirm,
  onCancel,
}: {
  ticket: StoredTicket;
  state: TransferState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (state.phase === "idle") return null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{ maxWidth: 420, width: "100%", margin: "var(--space-5)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {state.phase === "confirm" ? (
          <>
            <p style={{ fontWeight: 700, margin: 0 }}>Transfer this ticket?</p>
            <p style={{ color: "var(--ink-secondary)", fontSize: "0.875rem" }}>
              It is one-way and cannot be undone.
            </p>
            <div style={{ marginTop: "var(--space-4)", display: "flex", gap: "var(--space-3)" }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={onConfirm}>Transfer</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
            </div>
          </>
        ) : state.phase === "building" || state.phase === "broadcasting" ? (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <div className="spinner" />
            <p className="status-copy" style={{ margin: 0 }}>
              {state.phase === "building" ? "Building transfer..." : "Sending to Kaspa..."}
            </p>
          </div>
        ) : state.phase === "success" ? (
          <>
            <div className="status-icon status-icon-ok" style={{ marginBottom: "var(--space-3)" }}>
              <span>&#10003;</span>
            </div>
            <p style={{ fontWeight: 700, margin: 0 }}>Transferred.</p>
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: "var(--space-4)" }} onClick={onCancel}>
              Close
            </button>
          </>
        ) : state.phase === "error" ? (
          <>
            <div className="status-icon status-icon-error" style={{ marginBottom: "var(--space-3)" }}>
              <span>&#10007;</span>
            </div>
            <p style={{ fontWeight: 700, margin: 0 }}>{state.message}</p>
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: "var(--space-4)" }} onClick={onCancel}>
              Close
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function WalletPage() {
  const { state, connect } = useWallet();
  const [tickets, setTickets] = useState<StoredTicket[]>([]);
  const [transferState, setTransferState] = useState<TransferState>({ phase: "idle" });
  const [transferTicket, setTransferTicket] = useState<StoredTicket | null>(null);

  useEffect(() => {
    setTickets(loadTickets());
  }, []);

  const handleTransfer = useCallback((ticket: StoredTicket) => {
    setTransferTicket(ticket);
    setTransferState({ phase: "confirm", ticket });
  }, []);

  const handleTransferConfirm = useCallback(async () => {
    if (!transferTicket || state.status !== "connected" || !state.accounts[0]) return;
    const address = state.accounts[0];
    const publicKey = state.publicKey;

    setTransferState({ phase: "building" });

    try {
      const event = await fetchEvent(transferTicket.eventId);
      const buyInfo = event.buy_info;

      const utxos = await fetchUtxos(address);
      if (utxos.length === 0) {
        setTransferState({ phase: "error", message: "Not enough funds - transfer didn't go through." });
        return;
      }

      const ticketOutpoint = parseTicketOutpoint(transferTicket.ticketId);
      const newOwner = organizerPkh(publicKey);

      const buildResult = await buildTransferTx({
        ticket_outpoint: ticketOutpoint,
        event_covenant_id: buyInfo.event_covenant_id,
        eventId: event.event.event_id,
        price: transferTicket.price * SOMPI_PER_KAS,
        orgSpk: buyInfo.org_spk,
        burnTemplateHash: buyInfo.burn_template_hash,
        new_owner: newOwner,
        holderUtxos: utxos.map(toWireUtxo),
        changeSpk: changeScriptFromPublicKey(publicKey),
        inputUtxoMetas: utxos.map(toWireUtxoMeta),
      });

      setTransferState({ phase: "broadcasting" });

      const kasware = window.kasware;
      if (!kasware || !("signPskt" in kasware)) {
        setTransferState({ phase: "error", message: "Wallet not available." });
        return;
      }
      const signingJson = buildResult.signing_template;
      if (!signingJson) {
        setTransferState({ phase: "error", message: "No signing template." });
        return;
      }

      const signed = await kasware.signPskt({ txJsonString: signingJson });
      const json = typeof signed === "string" ? signed : String(signed);
      const parsed = JSON.parse(json) as {
        inputs?: Array<{ transactionId: string; index: number; signatureScript?: string }>;
      };
      const byInput = new Map(
        (parsed.inputs ?? []).map((input: { transactionId: string; index: number; signatureScript?: string }) =>
          [`${input.transactionId}:${input.index}`, input],
        ),
      );
      const signedTx: WireTransaction = {
        ...buildResult.template,
        inputs: buildResult.template.inputs.map((input) => {
          const key = `${input.previous_outpoint.transaction_id}:${input.previous_outpoint.index}`;
          const si = byInput.get(key);
          return { ...input, signature_script: si?.signatureScript ?? input.signature_script };
        }),
      };

      const result = await broadcastTx(signedTx);

      removeTicket(transferTicket.ticketId);
      const newTicket: StoredTicket = {
        ...transferTicket,
        ticketId: `${result.txid.toLowerCase()}:0`,
        buyTxId: result.txid.toLowerCase(),
      };
      saveTicket(newTicket);
      setTickets(loadTickets());
      setTransferState({ phase: "success" });
    } catch (err) {
      setTransferState({ phase: "error", message: errorMsg(err) });
    }
  }, [transferTicket, state]);

  const handleTransferCancel = useCallback(() => {
    setTransferState({ phase: "idle" });
    setTransferTicket(null);
    setTickets(loadTickets());
  }, []);

  const connected = state.status === "connected";
  const grouped = ticketsByEvent(tickets);

  return (
    <section>
      <h2 className="page-heading">My Tickets</h2>
      {!connected ? (
        <div className="empty">
          <p className="empty-title">Your tickets live here.</p>
          <p className="empty-sub">Connect your wallet to see what's yours.</p>
          <div className="empty-actions">
            <button type="button" className="btn btn-primary" onClick={connect}>Connect wallet</button>
          </div>
        </div>
      ) : tickets.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No tickets yet.</p>
          <p className="empty-sub">Find an event and grab a ticket.</p>
          <div className="empty-actions">
            <Link to="/" className="btn btn-primary">Browse events</Link>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          {Array.from(grouped.entries()).map(([eventId, eventTickets]) => (
            <div key={eventId}>
              <h3 style={{ margin: "0 0 var(--space-3)", fontSize: "1.125rem", fontWeight: 700 }}>
                {eventTickets[0]?.eventName ?? "Event"} &middot; {eventTickets.length}{" "}
                {eventTickets.length === 1 ? "ticket" : "tickets"}
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                {eventTickets.map((ticket) => (
                  <TicketCard key={ticket.ticketId} ticket={ticket} onTransfer={() => handleTransfer(ticket)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {transferTicket && (
        <TransferDialog
          ticket={transferTicket}
          state={transferState}
          onConfirm={handleTransferConfirm}
          onCancel={handleTransferCancel}
        />
      )}
    </section>
  );
}
