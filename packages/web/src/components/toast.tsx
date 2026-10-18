// The app's single toast channel (KTK-161 depends on it).
//
// One message is visible at a time. The store lives outside React so any module
// — a page action, a wallet hook, the API client — can publish without prop
// drilling, and the last caller owns the banner. The component owns the dwell
// timer, holds it while the message is hovered or focused, and dismisses on
// Escape.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type ToastTone = "error" | "info" | "notice" | "success";

export interface ToastAction {
  label: string;
  href: string;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
  dwellMs: number;
}

export interface ToastOptions {
  tone?: ToastTone;
  action?: ToastAction;
  dwellMs?: number;
}

/** Confirmations are quick; explanations stay long enough to read. */
export const TOAST_DWELL_MS: Record<ToastTone, number> = {
  success: 5_000,
  notice: 5_000,
  error: 8_000,
  info: 8_000,
};

let current: Toast | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Publish a toast, replacing the one on screen. */
export function showToast(message: string, options: ToastOptions = {}): Toast {
  const tone = options.tone ?? "info";
  current = {
    id: nextId++,
    tone,
    message,
    ...(options.action ? { action: options.action } : {}),
    dwellMs: options.dwellMs ?? TOAST_DWELL_MS[tone],
  };
  emit();
  return current;
}

/** Dismiss the current toast, or a specific one if `id` is supplied. */
export function dismissToast(id?: number): void {
  if (current === null) return;
  if (id !== undefined && current.id !== id) return;
  current = null;
  emit();
}

export function getToast(): Toast | null {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the current toast; re-renders whenever it changes. */
export function useToast(): Toast | null {
  return useSyncExternalStore(subscribe, getToast, getToast);
}

/** Mount once, in the app shell. */
export function ToastViewport() {
  const toast = useToast();
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastId = toast?.id;

  // A replacement toast is a new message: do not inherit a hold from the old one.
  useEffect(() => {
    setHeld(false);
  }, [toastId]);

  useEffect(() => {
    if (!toast || held) return;
    timer.current = setTimeout(() => dismissToast(toast.id), toast.dwellMs);
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [toast, held]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissToast();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!toast) return null;

  const isError = toast.tone === "error";

  return (
    <div
      className={`toast toast-${toast.tone}`}
      role={isError ? "alert" : "status"}
      aria-atomic="true"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setHeld(false);
      }}
    >
      <p className="toast-message">{toast.message}</p>
      {toast.action && (
        <a
          className="toast-action"
          href={toast.action.href}
          target="_blank"
          rel="noreferrer"
        >
          {toast.action.label}
        </a>
      )}
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
