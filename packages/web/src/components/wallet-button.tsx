import { useWallet } from "../hooks/use-wallet";

const INSTALL_URL = "https://kasware.xyz";
const ADDR_PREFIX_LEN = 6;
const ADDR_SUFFIX_LEN = 4;

export function WalletButton() {
  const { state, connect, disconnect } = useWallet();

  if (state.status === "not-installed") {
    return (
      <a
        href={INSTALL_URL}
        className="btn btn-secondary btn-sm"
        target="_blank"
        rel="noopener noreferrer"
      >
        Install Kasware
      </a>
    );
  }

  if (state.status === "connecting") {
    return (
      <button type="button" className="btn btn-secondary btn-sm" disabled>
        <span className="spinner" aria-hidden="true" />
        Connecting
      </button>
    );
  }

  if (state.status === "connected") {
    const address = state.accounts[0];
    return (
      <button type="button" className="connected-chip" onClick={disconnect} title="Disconnect">
        <span className="dot" aria-hidden="true" />
        {address ? shortAddress(address) : "Connected"}
      </button>
    );
  }

  return (
    <button type="button" className="btn btn-primary btn-sm" onClick={connect}>
      Connect wallet
    </button>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, ADDR_PREFIX_LEN)}...${address.slice(-ADDR_SUFFIX_LEN)}`;
}
