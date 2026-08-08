import { useWallet } from "../hooks/use-wallet";

const INSTALL_URL = "https://kasware.xyz";
const ADDR_PREFIX_LEN = 6;
const ADDR_SUFFIX_LEN = 4;

export function WalletButton() {
  const { state, connect, disconnect } = useWallet();

  if (state.status === "not-installed") {
    return (
      <a href={INSTALL_URL} target="_blank" rel="noopener noreferrer">
        Install Kasware
      </a>
    );
  }

  if (state.status === "connecting") {
    return (
      <button type="button" disabled>
        Connecting...
      </button>
    );
  }

  if (state.status === "connected") {
    const address = state.accounts[0];
    return (
      <button type="button" onClick={disconnect}>
        {address ? shortAddress(address) : "Connected"}
      </button>
    );
  }

  return (
    <button type="button" onClick={connect}>
      Connect Wallet
    </button>
  );
}

function shortAddress(address: string): string {
  return `${address.slice(0, ADDR_PREFIX_LEN)}...${address.slice(-ADDR_SUFFIX_LEN)}`;
}
