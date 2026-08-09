import { Link } from "react-router-dom";
import { useWallet } from "../hooks/use-wallet";

const INSTALL_URL = "https://kasware.xyz";
const ADDR_PREFIX_LEN = 6;
const ADDR_SUFFIX_LEN = 4;
const ADDR_PREFIX_LEN_SHORT = 4;

export function HeaderActions() {
  const { state, connect, disconnect } = useWallet();

  if (state.status === "not-installed") {
    return (
      <a
        href={INSTALL_URL}
        className="btn btn-primary btn-sm"
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
      <div className="header-actions">
        <Link to="/create" className="btn btn-primary btn-sm">
          <span className="create-label">Create event</span>
          <span className="create-icon" aria-hidden="true">+</span>
        </Link>
        <button
          type="button"
          className="connected-chip"
          onClick={disconnect}
          title="Disconnect"
        >
          <span className="dot" aria-hidden="true" />
          {address ? (
            <>
              <span className="address-full">{shortAddress(address)}</span>
              <span className="address-short">{shortAddressShort(address)}</span>
            </>
          ) : (
            "Connected"
          )}
        </button>
      </div>
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

function shortAddressShort(address: string): string {
  return `${address.slice(0, ADDR_PREFIX_LEN_SHORT)}...${address.slice(-ADDR_SUFFIX_LEN)}`;
}
