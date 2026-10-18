import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type DeployParams, type DeployState, executeDeploy } from "../api/deploy-machine";
import { EventForm, type EventFormData } from "./event-form";
import { DeployStatus } from "./deploy-dialog";
import { validate } from "./event-validate";
import { usePendingAction } from "../hooks/use-pending-action";

const EMPTY_FORM: EventFormData = { name: "", date: "", time: "", capacity: 0, price: 0 };

export function CreateEventDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;

      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [busy, onClose]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Create an event">
      <div className="dialog" ref={dialogRef} tabIndex={-1}>
        <button
          type="button"
          className="dialog-close"
          onClick={onClose}
          aria-label="Close"
          disabled={busy}
        >
          &times;
        </button>
        <CreateForm onClose={onClose} onBusyChange={setBusy} />
      </div>
    </div>
  );
}

function CreateForm({
  onClose,
  onBusyChange,
}: {
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const navigate = useNavigate();
  const [form, setForm] = useState<EventFormData>(EMPTY_FORM);
  const [deploy, setDeploy] = useState<DeployState>({ phase: "idle" });
  const [errors, setErrors] = useState<Partial<Record<keyof EventFormData, string>>>({});
  const pending = usePendingAction({ onReset: () => setDeploy({ phase: "idle" }) });
  const working =
    deploy.phase === "building" || deploy.phase === "signing" || deploy.phase === "broadcasting";
  const busy = working || pending.running;

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  const startDeploy = () => {
    void pending.start(({ publicKey, address }) => {
      const params: DeployParams = {
        capacity: form.capacity,
        priceKas: form.price,
        publicKey,
        address,
        name: form.name,
        date: form.date,
        time: form.time || undefined,
        isCurrent: pending.isCurrent,
      };
      return executeDeploy(setDeploy, params);
    });
  };

  if (deploy.phase !== "idle") {
    return (
      <DeployStatus
        status={deployPhaseStatus(deploy.phase)}
        error={deploy.phase === "error" ? deploy.message : undefined}
        txid={deploy.phase === "success" ? deploy.txid : undefined}
        onRetry={startDeploy}
        onDone={() => {
          navigate("/my-events");
          onClose();
        }}
      />
    );
  }

  return (
    <EventForm
      initial={form}
      onSubmit={(data) => {
        const errs = validate(data);
        if (Object.keys(errs).length > 0) {
          setErrors(errs);
          return;
        }
        setErrors({});
        startDeploy();
      }}
      errors={errors}
      onChange={setForm}
    />
  );
}

function deployPhaseStatus(
  phase: DeployState["phase"],
): "deploying" | "broadcasting" | "success" | "error" {
  if (phase === "building") return "deploying";
  if (phase === "signing" || phase === "broadcasting") return "broadcasting";
  if (phase === "success") return "success";
  return "error";
}
