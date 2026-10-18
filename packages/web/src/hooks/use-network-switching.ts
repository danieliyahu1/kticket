import { useSyncExternalStore } from "react";
import {
  isNetworkQuiet,
  isSwitchingNetwork,
  subscribeToNetworkStatus,
} from "../wallet/network-status";

/** True while an action owns a wallet network switch (KTK-172). */
export function useNetworkSwitching(): boolean {
  return useSyncExternalStore(
    subscribeToNetworkStatus,
    isSwitchingNetwork,
    isSwitchingNetwork,
  );
}

/** True just after a switch, so duplicate steady-state notices stay away. */
export function useNetworkQuiet(): boolean {
  return useSyncExternalStore(subscribeToNetworkStatus, isNetworkQuiet, isNetworkQuiet);
}
