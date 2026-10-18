// The app's toast state (KTK-161).
//
// One message is visible at a time. The store lives outside React so any module
// — a page action, a wallet hook, the API client — can publish without prop
// drilling, and the last caller owns the banner. This module has no view code;
// `ToastViewport` renders it.

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

/** The current value, for the React adapter and for tests. */
export function getToast(): Toast | null {
  return current;
}

/** Subscribe to changes, for the React adapter. */
export function subscribeToToast(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
