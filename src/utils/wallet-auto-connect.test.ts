import { describe, expect, it } from "vitest";
import { shouldAutoConnectWallet } from "./wallet-auto-connect";

describe("shouldAutoConnectWallet", () => {
  it("skips when user disconnected this session", () => {
    expect(
      shouldAutoConnectWallet({
        hasDisconnected: true,
        priorWalletName: "Phantom",
      }),
    ).toBe(false);
  });

  it("skips when no prior wallet was selected", () => {
    expect(
      shouldAutoConnectWallet({
        hasDisconnected: false,
        priorWalletName: null,
      }),
    ).toBe(false);
    expect(
      shouldAutoConnectWallet({
        hasDisconnected: false,
        priorWalletName: "  ",
      }),
    ).toBe(false);
  });

  it("allows when prior wallet exists and not disconnected", () => {
    expect(
      shouldAutoConnectWallet({
        hasDisconnected: false,
        priorWalletName: "Phantom",
      }),
    ).toBe(true);
  });
});
