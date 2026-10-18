// Observable network-switch status (KTK-172/175).
//
// The UI needs to know when an action owns the wallet switch (so the persistent
// banner and the header control stay out of the way) and for a short quiet
// window afterwards. This module owns that state and nothing else; the guard in
// `network.ts` drives it.

const QUIET_WINDOW_MS = 2_000;

let switching = false;
let quietUntil = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToNetworkStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while an action owns the switch. */
export function isSwitchingNetwork(): boolean {
  return switching;
}

/** True just after a switch, before steady-state notices may reclaim the UI. */
export function isNetworkQuiet(): boolean {
  return Date.now() < quietUntil;
}

export function beginNetworkSwitch(): void {
  switching = true;
  emit();
}

export function endNetworkSwitch(): void {
  switching = false;
  emit();
}

/** Open the quiet window and re-render when it closes. */
export function markNetworkSwitched(): void {
  quietUntil = Date.now() + QUIET_WINDOW_MS;
  setTimeout(emit, QUIET_WINDOW_MS);
}
