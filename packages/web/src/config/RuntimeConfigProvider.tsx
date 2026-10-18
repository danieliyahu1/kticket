// Boot-time runtime config (KTK-176).
//
// Mount once, above every wallet-aware provider. It blocks the first render for
// at most one config request, then publishes the server's network identity to
// React (via the store subscription) and to plain modules (via the same store).
// A failed request resolves to the build-time fallback, so the app still boots.

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import {
  getRuntimeSnapshot,
  loadRuntimeConfig,
  setRuntimeConfig,
  subscribeToRuntimeConfig,
  type RuntimeConfig,
} from "./runtime";

export function RuntimeConfigProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribeToRuntimeConfig,
    getRuntimeSnapshot,
    getRuntimeSnapshot,
  );

  useEffect(() => {
    let cancelled = false;
    void loadRuntimeConfig().then((loaded) => {
      // Applying after unmount would leak one test's config into the next.
      if (!cancelled) setRuntimeConfig(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!snapshot.loaded) {
    return (
      <div className="app-boot" role="status">
        <div className="spinner" aria-hidden="true" />
        <span>Connecting to the network…</span>
      </div>
    );
  }

  return <>{children}</>;
}

/** The runtime network identity, for components. */
export function useRuntimeConfig(): RuntimeConfig {
  return useSyncExternalStore(
    subscribeToRuntimeConfig,
    getRuntimeSnapshot,
    getRuntimeSnapshot,
  ).config;
}
