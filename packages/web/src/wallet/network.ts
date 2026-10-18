// The wallet-network guard (KTK-175).
//
// Every signing path calls `ensureWalletNetwork()` first, so a signature is
// never requested on the wrong chain. If the wallet is elsewhere, the guard
// asks it to switch, announces why, and waits for `networkChanged` (with a
// short poll in case the event never arrives) up to a deadline.
//
// A dismissed or rejected switch, or a timeout, is a quiet cancel: no error
// toast, no retry. The wallet still owns the consent; the app only automates
// the step.

import { showToast } from "../components/toast-store";
import { getRuntimeConfig, networkLabel, type RuntimeConfig } from "../config/runtime";
import { devLog, devWarn } from "../lib/log";
import { reasonOf } from "../auth/wallet-error";
import { matchesWalletNetwork } from "./network-match";
import {
  beginNetworkSwitch,
  endNetworkSwitch,
  markNetworkSwitched,
} from "./network-status";

const SWITCH_POLL_MS = 500;
const SWITCH_DEADLINE_MS = 10_000;

export interface EnsureNetworkOptions {
  /**
   * Announce the switch through the toast channel (default). A manual switch
   * from the header already says "Switching…", so it passes false.
   */
  announce?: boolean;
}

/**
 * Resolve when the wallet reports a network change, or after `ms` — the poll
 * fallback for extensions that switch without firing the event.
 */
function waitForNetworkChange(provider: NonNullable<Window["kasware"]>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      provider.removeListener("networkChanged", onChanged);
      resolve();
    };
    const onChanged = () => finish();
    timer = setTimeout(finish, ms);
    provider.on("networkChanged", onChanged);
  });
}

async function currentWalletNetwork(provider: NonNullable<Window["kasware"]>): Promise<string> {
  try {
    return await provider.getNetwork();
  } catch {
    return "";
  }
}

/**
 * Ask the wallet to switch. Returns true only when the reported network is the
 * server's afterwards; a rejection, dismissal, or timeout returns false.
 */
async function requestSwitch(
  provider: NonNullable<Window["kasware"]>,
  config: RuntimeConfig,
): Promise<boolean> {
  try {
    await provider.switchNetwork(config.walletNetwork);
  } catch (err) {
    // A dismissal is a cancel. Some extensions still perform the switch, so
    // check once before giving up.
    devWarn(`[wallet] network switch rejected err=${reasonOf(err)}`);
    return matchesWalletNetwork(await currentWalletNetwork(provider), config);
  }

  const deadline = Date.now() + SWITCH_DEADLINE_MS;
  while (true) {
    if (matchesWalletNetwork(await currentWalletNetwork(provider), config)) return true;
    if (Date.now() >= deadline) {
      devWarn("[wallet] network switch timed out");
      return false;
    }
    // Wait for the event, with a 500ms poll so a silent switch still lands.
    await waitForNetworkChange(provider, SWITCH_POLL_MS);
  }
}

/**
 * Resolve, once, the wallet's network:
 *   - already correct → true immediately, no prompt;
 *   - different → announce, switch, wait for the event or poll to the deadline;
 *   - canceled/rejected/timeout → false, quietly.
 */
export async function ensureWalletNetwork(options: EnsureNetworkOptions = {}): Promise<boolean> {
  const provider = window.kasware;
  if (!provider) return false;

  if (matchesWalletNetwork(await currentWalletNetwork(provider), getRuntimeConfig())) return true;

  const config = getRuntimeConfig();
  const announce = options.announce ?? true;
  beginNetworkSwitch();
  devLog(`[wallet] network switch required target=${config.walletNetwork}`);
  if (announce) {
    showToast(`Switching your wallet to ${networkLabel(config)}…`, { tone: "notice" });
  }

  const switched = await requestSwitch(provider, config).finally(endNetworkSwitch);

  if (!switched) return false;

  markNetworkSwitched();
  devLog(`[wallet] network switch ok network=${config.walletNetwork}`);
  if (announce) {
    showToast(`Your wallet is on ${networkLabel(config)}.`, { tone: "success" });
  }
  return true;
}
