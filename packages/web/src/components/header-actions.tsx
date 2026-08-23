import { useWallet } from "../hooks/use-wallet";
import { useCreateDialog } from "./create-dialog-context";

const INSTALL_URL =
  "https://chromewebstore.google.com/detail/kastle/oambclflhjfppdmkghokjmpppmaebego";
const ADDR_KEEP = 6;
const ADDR_TAIL = 4;

export function HeaderActions() {
  const { state, connect, disconnect, switchToWalletNetwork } = useWallet();
  const { openCreate } = useCreateDialog();

  if (state.status === "not-installed") {
    return (
      <a
        href={INSTALL_URL}
        className="button button-primary button-sm"
        target="_blank"
        rel="noopener noreferrer"
      >
        Install Kastle
      </a>
    );
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
        >
          Switch to Testnet
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
