import { describe, expect, it } from "vitest";
import type { UserToken } from "@/utils/jupiter";
import { TOKENS } from "@/utils/solana";
import {
  mergeTokensByMint,
  usdtUiBalance,
} from "@/components/signals/shared/row-holdings";

function token(partial: Partial<UserToken> & Pick<UserToken, "mintAddress">): UserToken {
  return {
    balance: 0,
    decimals: 6,
    uiAmount: 0,
    usdValue: 0,
    ...partial,
  };
}

describe("mergeTokensByMint", () => {
  it("sums duplicate accounts and reads USDT for the shared base picker", () => {
    const merged = mergeTokensByMint([
      token({
        mintAddress: TOKENS.USDT,
        balance: 1_000_000,
        uiAmount: 1,
        usdValue: 1,
      }),
      token({
        mintAddress: TOKENS.USDT,
        balance: 4_000_000,
        uiAmount: 4,
        usdValue: 4,
      }),
      token({
        mintAddress: "MemecoinMint",
        balance: 10,
        uiAmount: 10,
        decimals: 0,
      }),
    ]);
    expect(usdtUiBalance(merged)).toBe(5);
    expect(merged.get("memecoinmint")?.balance).toBe(10);
    expect(merged.get(TOKENS.USDT.toLowerCase())?.balance).toBe(5_000_000);
  });
});
