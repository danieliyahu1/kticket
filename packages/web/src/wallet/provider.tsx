import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { network } from "../network";
import type { KastleProvider, WalletState } from "./types";

export interface WalletContextValue {
  state: WalletState;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Ask the wallet to switch to the network this app runs on. */
  switchToWalletNetwork: () => Promise<void>;
}

export const WalletContext = createContext<WalletContextValue | null>(null);

// The extension injects `window.kastle` some time after page load; poll briefly
// and re-check on focus so a freshly installed/enabled wallet is detected.
const DETECT_POLL_MS = 200;
const DETECT_WINDOW_MS = 2_000;
const CONNECT_TIMEOUT_MS = 30_000;

function getKastle(): KastleProvider | undefined {
  return window.kastle;
}

/** The bech32 HRP every testnet-10 address carries (the only supported network). */
const TESTNET_ADDRESS_PREFIX = "kaspatest:";

/** True when a wallet account address belongs to the network this app runs on. */
function addressMatchesNetwork(address: string): boolean {
  return address.startsWith(TESTNET_ADDRESS_PREFIX);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>({ status: "idle" });
  const connectingRef = useRef(false);
  const accountRef = useRef<{ accounts: string[]; publicKey: string } | null>(null);

  const applyAccount = useCallback(async (provider: KastleProvider): Promise<boolean> => {
    try {
      const account = await provider.getAccount();
      if (!account?.address) return false;
      const next = { accounts: [account.address], publicKey: account.publicKey ?? "" };
      let walletNetwork: string | null = null;
      try {
        walletNetwork = await provider.getNetwork();
      } catch {
        // Network is advisory; don't block connection on it.
      }
    accountRef.current = next;
    if (walletNetwork !== null && walletNetwork !== network.networkId) {
      setState({ status: "wrong-network", ...next });
    } else {
      // The wallet may report the right network but hand back an address for a
      // different one (e.g. a stale mainnet `kaspa:` address). Flag it for the
      // UI but do not block — the user decides whether to proceed.
      setState({ status: "connected", ...next, networkMismatch: !addressMatchesNetwork(account.address) });
    }
    return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attached: KastleProvider | null = null;
    let detachListeners: (() => void) | undefined;

    const attach = (provider: KastleProvider) => {
      attached = provider;
      // Kastle emits KasWare-compatible events; an empty accounts array means
      // the wallet locked or disconnected.
      const onAccountsChanged = (accounts: unknown) => {
        const list = Array.isArray(accounts) ? accounts : [];
        if (list.length === 0) {
          accountRef.current = null;
          setState({ status: "disconnected" });
        } else {
          void applyAccount(provider);
        }
      };
      const onNetworkChanged = () => {
        if (accountRef.current) void applyAccount(provider);
      };
      provider.on("accountsChanged", onAccountsChanged);
      provider.on("networkChanged", onNetworkChanged);
      detachListeners = () => {
        provider.removeListener("accountsChanged", onAccountsChanged);
        provider.removeListener("networkChanged", onNetworkChanged);
      };
    };

    const detect = () => {
      const provider = getKastle();
      if (!provider || attached === provider || cancelled) return;
      setState((prev) => (prev.status === "not-installed" ? { status: "disconnected" } : prev));
      attach(provider);
    };

    detect();
    setState((prev) => (prev.status === "idle" ? { status: "not-installed" } : prev));
    const pollTimer = setInterval(detect, DETECT_POLL_MS);
    const stopTimer = setTimeout(() => clearInterval(pollTimer), DETECT_WINDOW_MS);
    const onFocus = () => detect();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearTimeout(stopTimer);
      window.removeEventListener("focus", onFocus);
      detachListeners?.();
    };
  }, [applyAccount]);

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    const provider = getKastle();
    if (!provider) {
      setState({ status: "not-installed" });
      return;
    }
    connectingRef.current = true;
    setState({ status: "connecting" });
    try {
      await withTimeout(
        Promise.resolve(provider.connect()),
        CONNECT_TIMEOUT_MS,
        "wallet approval",
      );
      const connected = await applyAccount(provider);
      if (!connected) setState({ status: "disconnected" });
    } catch {
      setState({ status: "disconnected" });
    } finally {
      connectingRef.current = false;
    }
  }, [applyAccount]);

  const disconnect = useCallback(() => {
    accountRef.current = null;
    setState({ status: "disconnected" });
  }, []);

  const switchToWalletNetwork = useCallback(async () => {
    const provider = getKastle();
    if (!provider) return;
    try {
      await withTimeout(
        Promise.resolve(provider.switchNetwork(network.networkId)),
        CONNECT_TIMEOUT_MS,
        "network switch",
      );
      // A successful switch also fires networkChanged, which re-syncs; do it
      // here as well in case the event never arrives.
      if (accountRef.current) await applyAccount(provider);
    } catch {
      // Keep the current state — the user can retry the switch.
    }
  }, [applyAccount]);

  return (
    <WalletContext.Provider value={{ state, connect, disconnect, switchToWalletNetwork }}>
      {children}
    </WalletContext.Provider>
  );
}
