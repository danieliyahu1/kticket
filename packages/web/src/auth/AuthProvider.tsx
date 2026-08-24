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

interface AuthActions {
  signIn: () => Promise<void>;
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

/** Challenge -> sign with the wallet -> session token (daftari's signInFlow). */
async function signInFlow(address: string): Promise<void> {
  const { message } = await createChallenge(address);
  const wallet = window.kastle;
  if (!(wallet && typeof wallet.signMessage === "function")) {
    throw new Error("Kastle wallet not available");
  }
  const signature = await wallet.signMessage(message);
  const { token } = await createSession(message, signature);
  setAuthToken(token);
  devLog(`[auth] session ready for ${address}`);
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const wallet = useWallet();
  const [state, setState] = useState<AuthState>({ status: "idle", error: null, address: null });
  const inFlightRef = useRef(false);
  const targetAddressRef = useRef<string | null>(null);

  const signIn = useCallback(async () => {
    const address = connectedAddress(wallet.state);
    if (!address) return;
    if (inFlightRef.current) return;
    targetAddressRef.current = address;
    inFlightRef.current = true;
    setState({ status: "signing-in", error: null, address: null });
    try {
      await signInFlow(address);
      setState({ status: "ready", error: null, address });
    } catch (err) {
      devWarn("[auth] sign-in failed", err instanceof Error ? err.message : typeof err);
      setAuthToken(null);
      setState({ status: "error", error: "Could not sign you in.", address: null });
    } finally {
      inFlightRef.current = false;
    }
  }, [wallet.state]);

  // Sign in whenever the connected wallet changes (mimics daftari's AuthProvider).
  useEffect(() => {
    const address = connectedAddress(wallet.state);
    if (!address) {
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