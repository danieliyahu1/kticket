import { beforeEach, describe, expect, it, vi } from "vitest";
import { WalletCanceledError } from "../wallet/cancel";
import { notifyCanceled, notifyFailure, notifySessionExpired } from "./notify";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../components/toast-store", () => ({ showToast }));

beforeEach(() => {
  showToast.mockClear();
});

describe("notify", () => {
  it("publishes failures with the mapped sentence and error tone", () => {
    notifyFailure(new Error("boom at handler (src/app.ts:12)"), "Couldn't load it.");

    expect(showToast).toHaveBeenCalledWith("Couldn't load it.", { tone: "error" });
  });

  it("publishes a wallet cancellation as a notice", () => {
    notifyCanceled(new WalletCanceledError());

    expect(showToast).toHaveBeenCalledWith("Canceled in your wallet.", { tone: "notice" });
  });

  it("publishes one session-expired sentence", () => {
    notifySessionExpired();

    expect(showToast).toHaveBeenCalledWith("Your session expired. Sign in to continue.", {
      tone: "notice",
    });
  });
});
