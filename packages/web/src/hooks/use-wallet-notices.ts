// App-level wallet notices (KTK-168).
//
// The persistent banner and header control explain steady state. This hook
// publishes only one transition through the shared toast channel: a wallet that
// drifts onto the wrong network. A switch that comes back already announces
// itself from the action or header that owns it.

import { useEffect, useRef } from "react";
import { networkLabel } from "../config/runtime";
import { useRuntimeConfig } from "../config/RuntimeConfigProvider";
import { showToast } from "../components/toast-store";
import { isNetworkQuiet } from "../wallet/network-status";
import { useNetworkSwitching } from "./use-network-switching";
import { useWallet } from "./use-wallet";

export function useWalletNotices(): void {
  const { state } = useWallet();
  const config = useRuntimeConfig();
  const switching = useNetworkSwitching();
  const previous = useRef(state.status);

  useEffect(() => {
    const from = previous.current;
    previous.current = state.status;

    // An action-owned switch announces itself; its quiet window also absorbs
    // the state transition it just caused.
    if (switching || isNetworkQuiet() || from === state.status) return;

    if (state.status === "wrong-network" && from === "connected") {
      showToast(
        `Your wallet moved to a different network. Switch to ${networkLabel(config)} to continue.`,
        { tone: "notice" },
      );
    }
  }, [state.status, switching, config]);
}
