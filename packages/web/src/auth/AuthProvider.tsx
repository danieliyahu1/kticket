import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet } from "../hooks/use-wallet";
import type { WalletState } from "../wallet/types";
import {
  createChallenge,
  createSession,
  getAuthAddress,
  getAuthToken,
  setAuthToken,
  setReauthHandler,
  setSessionExpiredHandler,
} from "../api/client";
import { devLog, devWarn } from "../lib/log";
import { notifyFailure, notifySessionExpired } from "../lib/notify";
import { ensureWalletNetwork } from "../wallet/network";
import { WalletCanceledError, isWalletCanceled } from "../wallet/cancel";
import { normalizeSignature } from "./signature";
import { codeOf, isUserRejected, reasonOf } from "./wallet-error";

/** The connected wallet's address, or undefined when not connected. */
function connectedAddress(state: WalletState): string | undefined {
  return state.status === "connected" ? state.accounts[0] : undefined;
}

export type AuthStatus = "idle" | "signing-in" | "ready" | "error";

interface AuthState {
  status: AuthStatus;
  error: string | null;
  address: string | null;
}

interface SignInOptions {
  /** Retry after a user cancel (the only thing that re-prompts). */
  force?: boolean;
  /** Publish a failure through the toast channel (action paths, not page gates). */
  notify?: boolean;
}

interface AuthActions {
  signIn: (options?: SignInOptions) => Promise<boolean>;
  /** Sign in as a specific address — the pending-action path, never stale. */
  signInFor: (address: string, options?: SignInOptions) => Promise<boolean>;
}

export type Auth = AuthState & AuthActions & { tokenPresent: boolean; tokenAddress: string | null };

const DEFAULT_AUTH: Auth = {
  status: "idle",
  error: null,
  address: null,
  signIn: async () => false,
  signInFor: async () => false,
  tokenPresent: false,
  tokenAddress: null,
};

const AuthContext = createContext<Auth>(DEFAULT_AUTH);

export function useAuth(): Auth {
  return useContext(AuthContext);
}

/** Short correlation id — matches the browser log line to the API log line. */
function newAttemptId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/**
 * Challenge -> sign with the wallet -> session token (daftari's signInFlow).
 * Every step is logged with the attempt id so a stalled flow is diagnosable
 * from the console alone (the wallet step is where it can hang, because
 * `signMessage` waits for a Kasware approval).
 */
async function signInFlow(address: string, attempt: string): Promise<void> {
  const startedAt = performance.now();
  let step = "challenge";
  try {
    const { nonce, message } = await createChallenge(address);
    devLog(`[auth] attempt=${attempt} challenge.ok nonce=${nonce.slice(0, 8)}`);

    step = "wallet";
    const wallet = window.kasware;
    devLog(`[auth] attempt=${attempt} wallet kasware=${typeof wallet} signMessage=${typeof wallet?.signMessage}`);
    if (!(wallet && typeof wallet.signMessage === "function")) {
      throw new Error("Kasware wallet not available");
    }

    step = "network";
    // Never ask for a signature on the wrong chain (KTK-175).
    if (!(await ensureWalletNetwork())) throw new WalletCanceledError("Network switch canceled.");

    step = "sign";
    devLog(`[auth] attempt=${attempt} sign.invoke`);
    const signStartedAt = performance.now();
    let raw: string;
    try {
      raw = await wallet.signMessage(message, { type: "schnorr" });
    } catch (err) {
      devWarn(`[auth] attempt=${attempt} sign.rejected ms=${elapsedMs(signStartedAt)} err=${reasonOf(err)}`);
      throw err;
    }
    devLog(
      `[auth] attempt=${attempt} sign.settled ok=true ms=${elapsedMs(signStartedAt)} type=${typeof raw} len=${typeof raw === "string" ? raw.length : -1}`,
    );

    step = "session";
    // The API verifies Schnorr over the personal message hash, and expects a
    // 128-hex signature; Kasware may return base64, so normalize it.
    const signature = normalizeSignature(raw);
    devLog(`[auth] attempt=${attempt} session.invoke`);
    const { token } = await createSession(message, signature);
    setAuthToken(token, address);
    devLog(`[auth] attempt=${attempt} session.ok totalMs=${elapsedMs(startedAt)}`);
  } catch (err) {
    devWarn(`[auth] attempt=${attempt} step=${step} err=${reasonOf(err)}`);
    throw err;
  }
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const wallet = useWallet();
  const [state, setState] = useState<AuthState>({ status: "idle", error: null, address: null });
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  // The address whose sign-in the user canceled. Automatic sign-in (on load or
  // a 401 re-auth) is suppressed for it until an explicit retry or a wallet
  // change — otherwise every background refresh would reopen the wallet popup.
  const canceledAddressRef = useRef<string | null>(null);

  /**
   * Sign in as `address`. The caller supplies the address it just connected,
   * so this never reads a stale wallet state. Returns true only when a token
   * for that address is in hand; a cancel resolves false and stops the caller.
   */
  const signInFor = useCallback(async (address: string, options?: SignInOptions): Promise<boolean> => {
    if (!address) return false;

    // A still-valid token for this address needs no wallet prompt.
    if (!options?.force && getAuthToken() !== null && getAuthAddress() === address) {
      setState({ status: "ready", error: null, address });
      return true;
    }

    if (!options?.force && canceledAddressRef.current === address) {
      devLog("[auth] signIn suppressed (canceled by the user)");
      return false;
    }
    // Join the sign-in already in flight instead of opening a second popup.
    if (inFlightRef.current) return inFlightRef.current;

    const run = (async (): Promise<boolean> => {
      canceledAddressRef.current = null;
      const attempt = newAttemptId();
      setState({ status: "signing-in", error: null, address: null });
      devLog(`[auth] attempt=${attempt} start address=${address}`);
      try {
        await signInFlow(address, attempt);
        setState({ status: "ready", error: null, address });
        return true;
      } catch (err) {
        setAuthToken(null);
        if (isUserRejected(err) || isWalletCanceled(err)) {
          canceledAddressRef.current = address;
          devWarn(`[auth] attempt=${attempt} canceled by user code=${codeOf(err) ?? "none"}`);
          setState({ status: "error", error: "Sign-in was canceled in Kasware.", address: null });
        } else {
          devWarn(`[auth] attempt=${attempt} failed err=${reasonOf(err)}`);
          setState({ status: "error", error: "Could not sign you in.", address: null });
          // A page-level AuthGate shows this inline; an action started from
          // anywhere else needs the shared channel (KTK-168).
          if (options?.notify) {
            notifyFailure(err, "Could not sign you in.");
          }
        }
        return false;
      }
    })();

    inFlightRef.current = run;
    try {
      return await run;
    } finally {
      inFlightRef.current = null;
    }
  }, []);

  const signIn = useCallback(
    async (options?: SignInOptions): Promise<boolean> => {
      const address = connectedAddress(wallet.state);
      if (!address) return false;
      return signInFor(address, options);
    },
    [wallet.state, signInFor],
  );

  // Sign in whenever the connected wallet changes (mimics daftari's AuthProvider).
  useEffect(() => {
    const address = connectedAddress(wallet.state);
    if (!address) {
      canceledAddressRef.current = null;
      setAuthToken(null);
      setState({ status: "idle", error: null, address: null });
      return;
    }
    if (state.address !== address) {
      void signIn();
    }
  }, [wallet.state, state.address, signIn]);

  // The API client calls this on a 401 to silently re-sign and retry.
  useEffect(() => {
    setReauthHandler(async () => {
      await signIn();
    });
    return () => setReauthHandler(null);
  }, [signIn]);

  // The client owns the 401 fact; the app owns the words (KTK-168).
  useEffect(() => {
    setSessionExpiredHandler(notifySessionExpired);
    return () => setSessionExpiredHandler(null);
  }, []);

  const value = useMemo<Auth>(
    () => ({
      status: state.status,
      error: state.error,
      address: state.address,
      signIn,
      signInFor,
      tokenPresent: getAuthToken() !== null,
      tokenAddress: getAuthAddress(),
    }),
    [state.status, state.error, state.address, signIn, signInFor],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}