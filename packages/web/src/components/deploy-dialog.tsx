import { Link } from "react-router-dom";
import { network } from "../network";

export interface DeployDialogProps {
  eventName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeployDialog({ eventName, onConfirm, onCancel }: DeployDialogProps) {
  return (
    <section>
      <div className="card">
        <h2 className="status-title">Put it on the chain?</h2>
        <p className="status-copy">
          {eventName} goes on Kaspa and stays there forever — no edits, no cancellation. Your wallet
          will ask you to approve it.
        </p>
        <div className="ticket-actions">
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Deploy
          </button>
          <button type="button" className="btn btn-link" onClick={onCancel}>
            Go back
          </button>
        </div>
        <p className="note">On {network.label}.</p>
      </div>
    </section>
  );
}

export interface DeployStatusProps {
  status: "deploying" | "broadcasting" | "success" | "error";
  error?: string;
  txid?: string;
  onRetry?: () => void;
}

const TXID_KEEP = 18;

function shortTxid(txid: string): string {
  return txid.length > TXID_KEEP ? `${txid.slice(0, TXID_KEEP)}…` : txid;
}

function Progress({ copy }: { copy: string }) {
  return (
    <div className="status" role="status">
      <div className="spinner" aria-hidden="true" />
      <p className="status-title">{copy}</p>
    </div>
  );
}

function Success({ txid }: { txid?: string }) {
  return (
    <div className="status">
      <div className="status-icon status-icon-ok" aria-hidden="true">
        <span>&#10003;</span>
      </div>
      <p className="status-title">Your event is live.</p>
      <p className="status-copy">Anyone with a ticket can get in.</p>
      {txid && (
        <p className="status-detail" title={txid}>
          {shortTxid(txid)}
        </p>
      )}
      <div className="ticket-actions">
        <Link to="/?filter=created" className="btn btn-primary">
          View my events &rarr;
        </Link>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="status">
      <div className="status-icon status-icon-error" aria-hidden="true">
        <span>&#10007;</span>
      </div>
      <p className="status-title">It didn't go through.</p>
      <p className="status-copy">{message}</p>
      <div className="ticket-actions">
        {onRetry && (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
      <p className="note">Nothing was created. Your event is not on the chain.</p>
    </div>
  );
}

export function DeployStatus({ status, error, txid, onRetry }: DeployStatusProps) {
  if (status === "deploying") return <Progress copy="Creating your event…" />;
  if (status === "broadcasting") return <Progress copy="Putting it on the chain…" />;
  if (status === "success") return <Success txid={txid} />;
  return <ErrorState message={error ?? "Deploy failed."} onRetry={onRetry} />;
}
