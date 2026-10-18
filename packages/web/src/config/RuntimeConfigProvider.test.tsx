// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeConfigProvider, useRuntimeConfig } from "./RuntimeConfigProvider";
import { FALLBACK_RUNTIME_CONFIG, resetRuntimeConfig } from "./runtime";

const CONFIG = {
  network: "testnet10",
  network_id: "testnet-10",
  wallet_network: "kaspa_testnet_10",
  address_prefix: "kaspatest:",
};

function Probe() {
  const config = useRuntimeConfig();
  return (
    <p>
      {config.network}|{config.networkId}|{config.walletNetwork}|{config.addressPrefix}
    </p>
  );
}

beforeEach(() => {
  resetRuntimeConfig();
});

afterEach(() => {
  cleanup();
  resetRuntimeConfig();
  vi.unstubAllGlobals();
});

describe("RuntimeConfigProvider (KTK-176)", () => {
  it("publishes the loaded runtime identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => CONFIG }),
    );

    render(
      <RuntimeConfigProvider>
        <Probe />
      </RuntimeConfigProvider>,
    );

    expect(await screen.findByText("testnet10|testnet-10|kaspa_testnet_10|kaspatest:")).toBeTruthy();
  });

  it("still boots with the fallback when the config request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(
      <RuntimeConfigProvider>
        <Probe />
      </RuntimeConfigProvider>,
    );

    const expected = `${FALLBACK_RUNTIME_CONFIG.network}|${FALLBACK_RUNTIME_CONFIG.networkId}|${FALLBACK_RUNTIME_CONFIG.walletNetwork}|${FALLBACK_RUNTIME_CONFIG.addressPrefix}`;
    expect(await screen.findByText(expected)).toBeTruthy();
  });
});
