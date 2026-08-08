export interface DeployDialogProps {
  eventName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeployDialog({ eventName, onConfirm, onCancel }: DeployDialogProps) {
  return (
    <section>
      <h2>Deploy event</h2>
      <p>{eventName}</p>
      <p>
        Deploy this event? Once it is on the chain it can never be changed — no edits, no
        cancellation.
      </p>
      <button type="button" onClick={onConfirm}>
        Deploy
      </button>
      <button type="button" onClick={onCancel}>
        Keep editing
      </button>
    </section>
  );
}

export interface DeployStatusProps {
  status: "deploying" | "broadcasting" | "success" | "error";
  error?: string;
  txid?: string;
}

export function DeployStatus({ status, error, txid }: DeployStatusProps) {
  if (status === "deploying") {
    return <p>Building transaction...</p>;
  }

  if (status === "broadcasting") {
    return <p>Broadcasting...</p>;
  }

  if (status === "success") {
    return (
      <section>
        <p>Event is live.</p>
        {txid && (
          <p>
            <small>{txid}</small>
          </p>
        )}
      </section>
    );
  }

  if (status === "error") {
    const message = error ?? "Deploy failed.";
    return <p>{message}</p>;
  }

  return null;
}
