import { useRuntimeConfig } from "../config/RuntimeConfigProvider";
import { networkLabel } from "../config/runtime";
import { useNetworkSwitching } from "../hooks/use-network-switching";
import { useWallet } from "../hooks/use-wallet";
import { useCreateDialog } from "./create-dialog-context";

const ADDR_KEEP = 6;
const ADDR_TAIL = 4;

export function HeaderActions() {
  const { state, connect, disconnect, switchToWalletNetwork } = useWallet();
  const { openCreate } = useCreateDialog();
  const config = useRuntimeConfig();
  const switching = useNetworkSwitching();

  // Nothing to connect to, and no install pitch in the masthead: the offer
  // lives where it can explain itself — the home page and the wallet gate
  // (issue #8). `idle` is the same silence until detection answers.
  if (state.status === "idle" || state.status === "not-installed") {
    return null;
  }

  if (state.status === "connecting") {
    return (
      <button type="button" className="button button-secondary button-sm" disabled>
        Connecting…
      </button>
    );
  }

  if (state.status === "wrong-network") {
    const address = state.accounts[0];
    return (
      <div className="header-actions">
        <span className="wallet-address" title={address}>
          {address ? shortAddress(address) : "Connected"}
        </span>
        <button
          type="button"
          className="button button-primary button-sm"
          onClick={switchToWalletNetwork}
          disabled={switching}
        >
          {switching ? "Switching…" : `Switch to ${networkLabel(config)}`}
        </button>
        <button
          type="button"
          className="button button-link button-sm"
          onClick={disconnect}
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (state.status === "connected") {
    const address = state.accounts[0];
    return (
      <div className="header-actions">
        <button type="button" className="button button-secondary button-sm" onClick={openCreate}>
          Create
        </button>
        <span className="wallet-address" title={address}>
          {address ? shortAddress(address) : "Connected"}
        </span>
        <button
          type="button"
          className="button button-link button-sm"
          onClick={disconnect}
        >
          Disconnect
        </button>
      </div>
    );
  }

  // disconnected: the wallet is installed, but no account is shared yet.
  return (
    <div className="header-actions">
      <button type="button" className="button button-secondary button-sm" onClick={openCreate}>
        Create
      </button>
      <button type="button" className="button button-primary button-sm" onClick={connect}>
        Connect wallet
      </button>
    </div>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, ADDR_KEEP)}...${address.slice(-ADDR_TAIL)}`;
}
