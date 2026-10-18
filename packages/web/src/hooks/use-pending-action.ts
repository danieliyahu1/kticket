// The shared pending-intent helper (KTK-177).
//
// One click resolves every prerequisite in order — wallet present, account
// connected, signed in, wallet on the server's network — and then runs the
// original action with the identity that was connected. A cancel at any step
// stops the chain; the action never runs. A second click while the chain is in
// flight is ignored (double-submit guard).

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { showToast } from "../components/toast-store";
import { devError } from "../lib/log";
import { notifyFailure } from "../lib/notify";
import { MISSING_WALLET_MESSAGE } from "../lib/present-error";
import { ensureWalletNetwork } from "../wallet/network";
import { isSwitchingNetwork } from "../wallet/network-status";
import type { ConnectedWallet } from "../wallet/provider";
import type { WalletState } from "../wallet/types";
import { useWallet } from "./use-wallet";

export interface PendingActionOptions {
  /** Reset page-held state (prepared ids, dialogs) when the wallet changes. */
  onReset?: () => void;
}

export interface PendingAction {
  /** True from the first click until the action settles. */
  running: boolean;
  /** Run `action` after the wallet is ready; resolves false when canceled. */
  start: (action: (wallet: ConnectedWallet) => Promise<void> | void) => Promise<boolean>;
  /** Guard for an in-flight action: false once the wallet changed underneath. */
  isCurrent: () => boolean;
}

function identityOf(state: WalletState): ConnectedWallet | null {
  if (state.status !== "connected" && state.status !== "wrong-network") return null;
  const address = state.accounts[0];
  return address ? { address, publicKey: state.publicKey } : null;
}

/**
 * True when the wallet no longer matches the flow's identity (KTK-173): it
 * disconnected, switched accounts, or drifted off the network after the guard
 * succeeded. The switch an action owns is not a drift.
 */
export function flowLostWallet(
  state: WalletState,
  identity: string,
  networkReady: boolean,
  switching: boolean,
): boolean {
  const walletGone =
    state.status === "disconnected" || state.status === "not-installed" || state.status === "idle";
  const accountChanged = identityOf(state)?.address !== identity;
  const networkDrifted = state.status === "wrong-network" && networkReady && !switching;
  return walletGone || accountChanged || networkDrifted;
}

export function usePendingAction(options: PendingActionOptions = {}): PendingAction {
  const { state, connect } = useWallet();
  const auth = useAuth();
  const [running, setRunning] = useState(false);

  const runningRef = useRef(false);
  const abortedRef = useRef(false);
  const identityRef = useRef<string | null>(null);
  const networkReadyRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const authRef = useRef(auth);
  authRef.current = auth;
  const connectRef = useRef(connect);
  connectRef.current = connect;
  const onResetRef = useRef(options.onReset);
  onResetRef.current = options.onReset;

  // Mid-flow reset (KTK-173): an account change, a disconnect, or a network
  // that drifts away after the guard succeeded abandons the flow. The switch
  // the action itself owns is not a drift.
  useEffect(() => {
    if (!runningRef.current || identityRef.current === null) return;
    if (!flowLostWallet(state, identityRef.current, networkReadyRef.current, isSwitchingNetwork())) {
      return;
    }

    abortedRef.current = true;
    identityRef.current = null;
    onResetRef.current?.();
    showToast("Your wallet changed — start again.", { tone: "notice" });
  }, [state]);

  const start = useCallback(
    async (action: (wallet: ConnectedWallet) => Promise<void> | void): Promise<boolean> => {
      if (runningRef.current) return false;

      runningRef.current = true;
      abortedRef.current = false;
      identityRef.current = null;
      networkReadyRef.current = false;
      setRunning(true);

      try {
        let identity = identityOf(stateRef.current);
        if (!identity) {
          showToast("Connecting your wallet…", { tone: "info" });
          identity = await connectRef.current();
        }
        if (!identity || abortedRef.current) {
          if (!window.kasware) {
            showToast(MISSING_WALLET_MESSAGE, { tone: "info" });
          }
          return false;
        }
        identityRef.current = identity.address;

        const tokenReady = authRef.current.tokenAddress === identity.address;
        if (!tokenReady) showToast("Sign in to continue.", { tone: "info" });
        const signedIn = await authRef.current.signInFor(identity.address, {
          force: !tokenReady,
          notify: true,
        });
        if (!signedIn || abortedRef.current) return false;

        const onNetwork = await ensureWalletNetwork();
        if (!onNetwork || abortedRef.current) return false;
        networkReadyRef.current = true;

        try {
          await action(identity);
        } catch (err) {
          devError("[pending-action] action failed", err);
          notifyFailure(err, "That didn't go through. Try again.");
          return false;
        }
        return true;
      } finally {
        runningRef.current = false;
        identityRef.current = null;
        setRunning(false);
      }
    },
    [],
  );

  const isCurrent = useCallback((): boolean => {
    if (abortedRef.current || identityRef.current === null) return false;
    return identityOf(stateRef.current)?.address === identityRef.current;
  }, []);

  return { running, start, isCurrent };
}
