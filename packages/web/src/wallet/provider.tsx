import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { network } from "../network";
import { devLog } from "../lib/log";
import type { KaswareProvider, WalletState } from "./types";

export interface WalletContextValue {
  state: WalletState;
  connect: () => Promise<void>;
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

/** The bech32 HRP every testnet-10 address carries (the only supported network). */
const TESTNET_ADDRESS_PREFIX = "kaspatest:";

/** The Kasware network name for the app's network (e.g. `kaspa_testnet_10`). */
function kaswareNetworkName(networkId: string): string {
  return `kaspa_${networkId.replace(/-/g, "_")}`;
}

/** True when a Kasware network name (e.g. `kaspa_testnet_10`) is the app's network. */
function networkMatches(walletNetwork: string, networkId: string): boolean {
  const normalized = walletNetwork.trim().toLowerCase().replace(/-/g, "_");
  const expected = networkId.toLowerCase().replace(/-/g, "_");
  return normalized === expected || normalized === `kaspa_${expected}`;
}

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

  const applyAccount = useCallback(async (provider: KaswareProvider): Promise<boolean> => {
    try {
      const accounts = await provider.getAccounts();
      const address = accounts[0];
      devLog(`[wallet] getAccounts ok count=${accounts.length}`);
      if (!address) return false;

      let publicKey = "";
      try {
        publicKey = await provider.getPublicKey();
      } catch {
        // The public key is advisory; don't block connection on it.
      }
      devLog(`[wallet] publicKey present=${publicKey.length > 0}`);

      let walletNetwork: string | null = null;
      try {
        walletNetwork = await provider.getNetwork();
      } catch {
        // Network is advisory; don't block connection on it.
      }
      const hasNetwork = walletNetwork !== null && walletNetwork !== "";
      const matches =
        walletNetwork !== null && walletNetwork !== "" && networkMatches(walletNetwork, network.networkId);
      devLog(
        `[wallet] network reported=${String(walletNetwork)} expected=${network.networkId} match=${hasNetwork ? String(matches) : "unknown"}`,
      );

      const next = { accounts: [address], publicKey };
      accountRef.current = next;
      if (hasNetwork && !matches) {
        devLog("[wallet] state=wrong-network");
        setState({ status: "wrong-network", ...next });
      } else {
        // The wallet may report the right network but hand back an address for a
        // different one (e.g. a stale mainnet `kaspa:` address). Flag it for the
        // UI but do not block — the user decides whether to proceed.
        const networkMismatch = !addressMatchesNetwork(address);
        devLog(`[wallet] state=connected networkMismatch=${networkMismatch}`);
        setState({ status: "connected", ...next, networkMismatch });
      }
      return true;
    } catch (err) {
      devLog(`[wallet] applyAccount failed err=${err instanceof Error ? err.message : typeof err}`);
      return false;
    }
  }, []);

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

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    const provider = getKasware();
    if (!provider) {
      setState({ status: "not-installed" });
      return;
    }
    connectingRef.current = true;
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
        return;
      }
      const connected = await applyAccount(provider);
      if (!connected) setState({ status: "disconnected" });
    } catch (err) {
      devLog(`[wallet] connect failed err=${err instanceof Error ? err.message : typeof err}`);
      setState({ status: "disconnected" });
    } finally {
      connectingRef.current = false;
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
    const target = kaswareNetworkName(network.networkId);
    devLog(`[wallet] switchNetwork start target=${target}`);
    try {
      await withTimeout(
        Promise.resolve(provider.switchNetwork(target)),
        CONNECT_TIMEOUT_MS,
        "network switch",
      );
      devLog("[wallet] switchNetwork ok");
      // A successful switch also fires networkChanged, which re-syncs; do it
      // here as well in case the event never arrives.
      if (accountRef.current) await applyAccount(provider);
    } catch (err) {
      devLog(`[wallet] switchNetwork failed err=${err instanceof Error ? err.message : typeof err}`);
      // Keep the current state — the user can retry the switch.
    }
  }, [applyAccount]);

  return (
    <WalletContext.Provider value={{ state, connect, disconnect, switchToWalletNetwork }}>
      {children}
    </WalletContext.Provider>
  );
}
