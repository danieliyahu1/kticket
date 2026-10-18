import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { showToast } from "../components/toast-store";
import { networkLabel } from "../config/runtime";
import { useRuntimeConfig } from "../config/RuntimeConfigProvider";
import { devLog } from "../lib/log";
import { addressMatchesNetwork, matchesWalletNetwork } from "./network-match";
import { ensureWalletNetwork } from "./network";
import type { KaswareProvider, WalletState } from "./types";

/** The connected wallet's identity, resolved before an action runs. */
export interface ConnectedWallet {
  address: string;
  publicKey: string;
}

export interface WalletContextValue {
  state: WalletState;
  /** Connect (or return the existing connection). Null when canceled. */
  connect: () => Promise<ConnectedWallet | null>;
  disconnect: () => void;
  /** Ask the wallet to switch to the network this app runs on. */
  switchToWalletNetwork: () => Promise<void>;
}

export const WalletContext = createContext<WalletContextValue | null>(null);

// The extension injects `window.kasware` some time after page load; poll briefly
// and re-check on focus so a freshly installed/enabled wallet is detected.
const DETECT_POLL_MS = 200;
const DETECT_WINDOW_MS = 2_000;
const CONNECT_TIMEOUT_MS = 30_000;

function getKasware(): KaswareProvider | undefined {
  return window.kasware;
}

/** Method names we rely on, for the detection log (types only, never calls). */
const KASWARE_METHODS = [
  "requestAccounts",
  "getAccounts",
  "getPublicKey",
  "getNetwork",
  "switchNetwork",
  "disconnect",
  "signMessage",
  "signPskt",
] as const;

function describeMethods(provider: KaswareProvider | undefined): string {
  if (!provider) return "";
  const record = provider as unknown as Record<string, unknown>;
  return KASWARE_METHODS.filter((m) => typeof record[m] === "function").join(" ");
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

interface WalletFacts {
  address: string;
  publicKey: string;
  /** Empty when the wallet does not report it (advisory). */
  walletNetwork: string;
}

/**
 * Read the wallet's current facts. Public key and network are advisory: a
 * wallet that cannot answer either must not block connecting.
 */
async function readWalletFacts(provider: KaswareProvider): Promise<WalletFacts | null> {
  const accounts = await provider.getAccounts();
  const address = accounts[0];
  if (!address) return null;

  let publicKey = "";
  try {
    publicKey = await provider.getPublicKey();
  } catch {
    // The public key is advisory; don't block connection on it.
  }

  let walletNetwork = "";
  try {
    walletNetwork = await provider.getNetwork();
  } catch {
    // Network is advisory; don't block connection on it.
  }

  return { address, publicKey, walletNetwork };
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const networkConfig = useRuntimeConfig();
  const [state, setState] = useState<WalletState>({ status: "idle" });
  const connectingRef = useRef<Promise<ConnectedWallet | null> | null>(null);
  const accountRef = useRef<{ address: string; publicKey: string } | null>(null);

  const applyAccount = useCallback(
    async (provider: KaswareProvider): Promise<ConnectedWallet | null> => {
      try {
        const facts = await readWalletFacts(provider);
        if (!facts) return null;
        const { address, publicKey, walletNetwork } = facts;
        const hasNetwork = walletNetwork !== "";
        const matches = hasNetwork && matchesWalletNetwork(walletNetwork, networkConfig);
        devLog(`[wallet] publicKey present=${publicKey.length > 0}`);
        devLog(
          `[wallet] network reported=${walletNetwork} expected=${networkConfig.networkId} match=${hasNetwork ? String(matches) : "unknown"}`,
        );

        const next = { address, publicKey };
        accountRef.current = next;
        if (hasNetwork && !matches) {
          devLog("[wallet] state=wrong-network");
          setState({ status: "wrong-network", accounts: [address], publicKey });
          return next;
        }

        // The wallet may report the right network but hand back an address for
        // a different one (e.g. a stale mainnet `kaspa:` address). Flag it for
        // the UI but do not block — the user decides whether to proceed.
        const networkMismatch = !addressMatchesNetwork(address, networkConfig);
        devLog(`[wallet] state=connected networkMismatch=${networkMismatch}`);
        setState({ status: "connected", accounts: [address], publicKey, networkMismatch });
        return next;
      } catch (err) {
        devLog(`[wallet] applyAccount failed err=${err instanceof Error ? err.message : typeof err}`);
        return null;
      }
    },
    [networkConfig],
  );

  useEffect(() => {
    let cancelled = false;
    let attached: KaswareProvider | null = null;
    let detachListeners: (() => void) | undefined;

    const attach = (provider: KaswareProvider) => {
      attached = provider;
      const onAccountsChanged = (accounts: unknown) => {
        const list = Array.isArray(accounts) ? accounts : [];
        devLog(`[wallet] event accountsChanged count=${list.length}`);
        if (list.length === 0) {
          accountRef.current = null;
          setState({ status: "disconnected" });
        } else {
          void applyAccount(provider);
        }
      };
      const onNetworkChanged = () => {
        devLog("[wallet] event networkChanged");
        if (accountRef.current) void applyAccount(provider);
      };
      const onDisconnect = () => {
        devLog("[wallet] event disconnect");
        accountRef.current = null;
        setState({ status: "disconnected" });
      };
      provider.on("accountsChanged", onAccountsChanged);
      provider.on("networkChanged", onNetworkChanged);
      provider.on("disconnect", onDisconnect);
      detachListeners = () => {
        provider.removeListener("accountsChanged", onAccountsChanged);
        provider.removeListener("networkChanged", onNetworkChanged);
        provider.removeListener("disconnect", onDisconnect);
      };
    };

    const detect = () => {
      const provider = getKasware();
      if (!provider || attached === provider || cancelled) return;
      devLog(`[wallet] detect present=true methods=[${describeMethods(provider)}]`);
      attach(provider);
      // Restore an existing session without prompting (`getAccounts` is safe).
      void applyAccount(provider).then((connected) => {
        if (!cancelled && !connected) setState({ status: "disconnected" });
      });
    };

    if (getKasware()) {
      detect();
    } else {
      devLog("[wallet] detect present=false");
      setState((prev) => (prev.status === "idle" ? { status: "not-installed" } : prev));
    }
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

  const connect = useCallback(async (): Promise<ConnectedWallet | null> => {
    // Already connected: hand back the identity without prompting again.
    if (accountRef.current) return accountRef.current;
    // A second click joins the request already in flight instead of opening a
    // second wallet popup (double-submit guard).
    if (connectingRef.current) return connectingRef.current;

    const provider = getKasware();
    if (!provider) {
      setState({ status: "not-installed" });
      return null;
    }

    const run = (async (): Promise<ConnectedWallet | null> => {
      setState({ status: "connecting" });
      devLog("[wallet] connect start");
      try {
        const accounts = await withTimeout(
          provider.requestAccounts(),
          CONNECT_TIMEOUT_MS,
          "wallet approval",
        );
        devLog(`[wallet] requestAccounts ok count=${accounts.length}`);
        if (accounts.length === 0) {
          setState({ status: "disconnected" });
          return null;
        }
        const connected = await applyAccount(provider);
        if (!connected) setState({ status: "disconnected" });
        return connected;
      } catch (err) {
        // A dismissal is a cancel: return quietly and let the caller stop.
        devLog(`[wallet] connect canceled err=${err instanceof Error ? err.message : typeof err}`);
        setState({ status: "disconnected" });
        return null;
      }
    })();

    connectingRef.current = run;
    try {
      return await run;
    } finally {
      connectingRef.current = null;
      devLog("[wallet] connect end");
    }
  }, [applyAccount]);

  const disconnect = useCallback(() => {
    devLog("[wallet] disconnect");
    accountRef.current = null;
    setState({ status: "disconnected" });
    const provider = getKasware();
    if (provider) {
      void provider.disconnect(window.location.origin).catch(() => {
        // Local state is already reset; a wallet-side failure is non-fatal.
      });
    }
  }, []);

  const switchToWalletNetwork = useCallback(async () => {
    const provider = getKasware();
    if (!provider) return;
    // The header control says "Switching…" while it runs; the outcome is one
    // toast, not a second "switching" message (KTK-168/172).
    const switched = await ensureWalletNetwork({ announce: false });
    if (!switched) return;
    showToast(`Your wallet is on ${networkLabel(networkConfig)}.`, { tone: "success" });
    // A successful switch also fires networkChanged, which re-syncs; do it
    // here as well in case the event never arrives.
    if (accountRef.current) await applyAccount(provider);
  }, [applyAccount, networkConfig]);

  return (
    <WalletContext.Provider value={{ state, connect, disconnect, switchToWalletNetwork }}>
      {children}
    </WalletContext.Provider>
  );
}
