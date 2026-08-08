import { useContext } from "react";
import type { WalletContextValue } from "../wallet/provider";
import { WalletContext } from "../wallet/provider";

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return ctx;
}
