export interface DeployStatusProps {
  status: "deploying" | "broadcasting" | "success" | "error";
  error?: string;
  txid?: string;
  onRetry?: () => void;
  onDone?: () => void;
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

function Success({ txid, onDone }: { txid?: string; onDone?: () => void }) {
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
      {onDone && (
        <div className="form-actions">
          <button type="button" className="button button-primary" onClick={onDone}>
            View my events
          </button>
        </div>
      )}
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
      <div className="form-actions">
        {onRetry && (
          <button type="button" className="button button-primary" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
      <p className="note">Nothing was created.</p>
    </div>
  );
}

export function DeployStatus({ status, error, txid, onRetry, onDone }: DeployStatusProps) {
  if (status === "deploying") return <Progress copy="Creating your event…" />;
  if (status === "broadcasting") return <Progress copy="Putting it on the chain…" />;
  if (status === "success") return <Success txid={txid} onDone={onDone} />;
  return <ErrorState message={error ?? "Deploy failed."} onRetry={onRetry} />;
}
