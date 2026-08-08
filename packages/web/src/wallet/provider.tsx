import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { KaswareProvider, WalletState } from "./types";

export interface WalletContextValue {
  state: WalletState;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export const WalletContext = createContext<WalletContextValue | null>(null);

function getKasware(): KaswareProvider | undefined {
  return window.kasware;
}

function useKaswareDetection(setState: (state: WalletState) => void) {
  useEffect(() => {
    const provider = getKasware();
    if (!provider) {
      setState({ status: "not-installed" });
      return;
    }
    setState({ status: "disconnected" });

    const onAccountsChanged = () => {
      provider.requestAccounts().then(
        (accounts) => {
          if (accounts.length === 0) {
            setState({ status: "disconnected" });
          }
        },
        () => {
          setState({ status: "disconnected" });
        },
      );
    };

    provider.on("accountsChanged", onAccountsChanged);
    provider.on("disconnect", () => setState({ status: "disconnected" }));

    return () => {
      provider.removeListener("accountsChanged", onAccountsChanged);
      provider.removeListener("disconnect", () => setState({ status: "disconnected" }));
    };
  }, [setState]);
}

async function requestConnection(
  provider: KaswareProvider,
): Promise<{ accounts: string[]; publicKey: string } | "empty"> {
  const accounts = await provider.requestAccounts();
  if (accounts.length === 0) return "empty";
  const publicKey = await provider.getPublicKey();
  return { accounts, publicKey };
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>({ status: "idle" });
  const connectingRef = useRef(false);

  useKaswareDetection(setState);

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    const provider = getKasware();
    if (!provider) {
      setState({ status: "not-installed" });
      return;
    }
    connectingRef.current = true;
    setState({ status: "connecting" });
    try {
      const result = await requestConnection(provider);
      if (result === "empty") {
        setState({ status: "disconnected" });
        return;
      }
      setState({ status: "connected", accounts: result.accounts, publicKey: result.publicKey });
    } catch {
      setState({ status: "disconnected" });
    } finally {
      connectingRef.current = false;
    }
  }, []);

  const disconnect = useCallback(() => {
    setState({ status: "disconnected" });
  }, []);

  return (
    <WalletContext.Provider value={{ state, connect, disconnect }}>
      {children}
    </WalletContext.Provider>
  );
}
