import { Link } from "react-router-dom";

export interface EmptyProps {
  title: string;
  sub: string;
  actionLabel: string;
  actionTo?: string;
  /** An external destination, opened in a new tab (e.g. a wallet install). */
  actionHref?: string;
  onAction?: () => void;
}

type EmptyActionProps = Omit<EmptyProps, "title" | "sub">;

export function Empty({ title, sub, ...action }: EmptyProps) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <p className="empty-sub">{sub}</p>
      <div className="empty-actions">
        <EmptyAction {...action} />
      </div>
    </div>
  );
}

export function OfflineEmpty({ onRetry }: { onRetry: () => void }) {
  return (
    <Empty
      title="The server isn't responding."
      sub="Try again in a moment."
      actionLabel="Try again"
      onAction={onRetry}
    />
  );
}

function EmptyAction({ actionLabel, actionTo, actionHref, onAction }: EmptyActionProps) {
  if (actionHref) {
    return (
      <a
        className="button button-primary"
        href={actionHref}
        target="_blank"
        rel="noopener noreferrer"
      >
        {actionLabel}
      </a>
    );
  }

  if (actionTo) {
    return (
      <Link to={actionTo} className="button button-primary">
        {actionLabel}
      </Link>
    );
  }

  return (
    <button type="button" className="button button-primary" onClick={onAction}>
      {actionLabel}
    </button>
  );
}
