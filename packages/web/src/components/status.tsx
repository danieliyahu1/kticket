import { Link } from "react-router-dom";

export function Progress({ copy }: { copy: string }) {
  return (
    <div className="status" role="status">
      <div className="spinner" aria-hidden="true" />
      <p className="status-title">{copy}</p>
    </div>
  );
}

export function Success({
  title,
  copy,
  txid,
  actions,
  note,
}: {
  title: string;
  copy?: string;
  txid?: string;
  actions?: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="status">
      <div className="status-icon status-icon-ok" aria-hidden="true">
        <span>&#10003;</span>
      </div>
      <p className="status-title">{title}</p>
      {copy && <p className="status-copy">{copy}</p>}
      {txid && (
        <p className="status-detail" title={txid}>
          {txid.length > 18 ? `${txid.slice(0, 18)}…` : txid}
        </p>
      )}
      {actions}
      {note && <p className="note">{note}</p>}
    </div>
  );
}

export function ErrorState({
  message,
  retryLabel,
  onRetry,
  note,
}: {
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
  note?: string;
}) {
  return (
    <div className="status">
      <div className="status-icon status-icon-error" aria-hidden="true">
        <span>&#10007;</span>
      </div>
      <p className="status-title">{message}</p>
      {onRetry && (
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {retryLabel ?? "Try again"}
          </button>
        </div>
      )}
      {note && <p className="note">{note}</p>}
    </div>
  );
}
