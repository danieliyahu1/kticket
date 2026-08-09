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
import { broadcastTx, buildTransferTx, fetchEvent } from "../api/client";
import { organizerPkh } from "../api/crypto";
import { changeScriptFromPublicKey, fetchUtxos, toWireUtxo, toWireUtxoMeta } from "../api/kaspa";
import type { WireOutpoint } from "../api/types";
import { priceLabel, whenLabel } from "../lib/format";
import { mergeSignatures, SOMPI_PER_KAS } from "../lib/signing";
import { Empty } from "../components/empty";

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
        <div className="ticket-line-price">{priceLabel(ticket.price)}</div>
      </div>
      <div className="ticket-perforation" />
      <div className="ticket-stub">
        <div className="stub-item">
          <span className="stub-label">Ticket ID</span>
          <span className="stub-value stub-value-sm mono">
            {ticket.ticketId.slice(0, 10)}...
          </span>
        </div>
        <button type="button" className="btn btn-link btn-sm btn-link-clean" onClick={onTransfer}>
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
    <div className="overlay" onClick={onCancel}>
      <div className="card overlay-card" onClick={(e) => e.stopPropagation()}>
        {state.phase === "confirm" ? (
          <>
            <p className="modal-heading">Transfer this ticket?</p>
            <p className="modal-sub">
              It is one-way and cannot be undone.
            </p>
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
        authorizingTxId: event.buy_info.authorizing_txid,
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
      const signedTx = mergeSignatures(buildResult.template, signed);

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
        <Empty
          title="Your tickets live here."
          sub="Connect your wallet to see what's yours."
          actionLabel="Connect wallet"
          onAction={connect}
        />
      ) : tickets.length === 0 ? (
        <Empty
          title="No tickets yet."
          sub="Find an event and grab a ticket."
          actionLabel="Browse events"
          actionTo="/"
        />
      ) : (
        <div className="ticket-group-list">
          {Array.from(grouped.entries()).map(([eventId, eventTickets]) => (
            <div key={eventId}>
              <h3 className="ticket-group-heading">
                {eventTickets[0]?.eventName ?? "Event"} &middot; {eventTickets.length}{" "}
                {eventTickets.length === 1 ? "ticket" : "tickets"}
              </h3>
              <div className="ticket-group">
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
