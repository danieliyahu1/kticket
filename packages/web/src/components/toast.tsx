// The single toast view (KTK-161).
//
// It renders the store's current message, owns the dwell timer, holds the
// message while hovered or focused, and dismisses on Escape. Mount once, in the
// app shell.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  dismissToast,
  getToast,
  subscribeToToast,
  type Toast,
  type ToastAction,
} from "./toast-store";

function useToast(): Toast | null {
  return useSyncExternalStore(subscribeToToast, getToast, getToast);
}

export function ToastViewport() {
  const toast = useToast();
  // Holding is tied to the message being held: a replacement toast starts with
  // its own dwell instead of inheriting the previous hold.
  const [heldToastId, setHeldToastId] = useState<number | null>(null);
  const held = toast !== null && heldToastId === toast.id;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!toast || held) return;
    timer.current = setTimeout(() => dismissToast(toast.id), toast.dwellMs);
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [toast, held]);

  useEscapeToDismiss();

  if (!toast) return null;

  return (
    <div
      className={`toast toast-${toast.tone}`}
      onMouseEnter={() => setHeldToastId(toast.id)}
      onMouseLeave={() => setHeldToastId(null)}
      onFocus={() => setHeldToastId(toast.id)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setHeldToastId(null);
      }}
    >
      <ToastMessage toast={toast} />
      {toast.action && <ToastActionLink action={toast.action} />}
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss notification"
        onClick={() => dismissToast(toast.id)}
      >
        &times;
      </button>
    </div>
  );
}

function ToastMessage({ toast }: { toast: Toast }) {
  return (
    <p
      className="toast-message"
      role={toast.tone === "error" ? "alert" : "status"}
      aria-atomic="true"
    >
      {toast.message}
    </p>
  );
}

function ToastActionLink({ action }: { action: ToastAction }) {
  return (
    <a className="toast-action" href={action.href} target="_blank" rel="noreferrer">
      {action.label}
    </a>
  );
}

function useEscapeToDismiss(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissToast();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
