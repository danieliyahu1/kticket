import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet } from "../hooks/use-wallet";
import type { WalletState } from "../wallet/types";
import {
  createChallenge,
  createSession,
  getAuthToken,
  setAuthToken,
  setReauthHandler,
} from "../api/client";
import { devLog, devWarn } from "../lib/log";
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
}

interface AuthActions {
  signIn: (options?: SignInOptions) => Promise<void>;
}

export type Auth = AuthState & AuthActions & { tokenPresent: boolean };

const DEFAULT_AUTH: Auth = {
  status: "idle",
  error: null,
  address: null,
  signIn: async () => {},
  tokenPresent: false,
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
    setAuthToken(token);
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
  const inFlightRef = useRef(false);
  const targetAddressRef = useRef<string | null>(null);
  // The address whose sign-in the user canceled. Automatic sign-in (on load or
  // a 401 re-auth) is suppressed for it until an explicit retry or a wallet
  // change — otherwise every background refresh would reopen the wallet popup.
  const canceledAddressRef = useRef<string | null>(null);

  const signIn = useCallback(async (options?: SignInOptions) => {
    const address = connectedAddress(wallet.state);
    if (!address) return;
    if (!options?.force && canceledAddressRef.current === address) {
      devLog("[auth] signIn suppressed (canceled by the user)");
      return;
    }
    if (inFlightRef.current) {
      devLog("[auth] signIn skipped (already in flight)");
      return;
    }
    canceledAddressRef.current = null;
    const attempt = newAttemptId();
    targetAddressRef.current = address;
    inFlightRef.current = true;
    setState({ status: "signing-in", error: null, address: null });
    devLog(`[auth] attempt=${attempt} start address=${address}`);
    try {
      await signInFlow(address, attempt);
      setState({ status: "ready", error: null, address });
    } catch (err) {
      setAuthToken(null);
      if (isUserRejected(err)) {
        canceledAddressRef.current = address;
        devWarn(`[auth] attempt=${attempt} canceled by user code=${codeOf(err) ?? "none"}`);
        setState({ status: "error", error: "Sign-in was canceled in Kasware.", address: null });
      } else {
        devWarn(`[auth] attempt=${attempt} failed err=${reasonOf(err)}`);
        setState({ status: "error", error: "Could not sign you in.", address: null });
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [wallet.state]);

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
    setReauthHandler(() => signIn());
    return () => setReauthHandler(null);
  }, [signIn]);

  // A fresh sign-in only replaces an existing valid token for the same address;
  // clear a stale token from a previous address once the new one lands.
  useEffect(() => {
    if (state.status === "ready" && state.address) {
      targetAddressRef.current = null;
    }
  }, [state.status, state.address]);

  const value = useMemo<Auth>(
    () => ({
      status: state.status,
      error: state.error,
      address: state.address,
      signIn,
      tokenPresent: getAuthToken() !== null,
    }),
    [state.status, state.error, state.address, signIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}