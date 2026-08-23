/**
 * Console output that exists only in development builds — Vite replaces the
 * flag statically, so production bundles ship none of these calls. Anything
 * durable belongs in the backend's structured logs instead.
 */
const ENABLED = import.meta.env.DEV;

export function devLog(...args: unknown[]): void {
  if (ENABLED) console.log(...args);
}

export function devWarn(...args: unknown[]): void {
  if (ENABLED) console.warn(...args);
}

export function devError(...args: unknown[]): void {
  if (ENABLED) console.error(...args);
}
