import { Link } from "react-router-dom";

export interface EmptyProps {
  title: string;
  sub: string;
  actionLabel: string;
  actionTo?: string;
  onAction?: () => void;
}

export function Empty({ title, sub, actionLabel, actionTo, onAction }: EmptyProps) {
  const action = actionTo ? (
    <Link to={actionTo} className="button button-primary">
      {actionLabel}
    </Link>
  ) : (
    <button type="button" className="button button-primary" onClick={onAction}>
      {actionLabel}
    </button>
  );
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      <p className="empty-sub">{sub}</p>
      <div className="empty-actions">{action}</div>
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
