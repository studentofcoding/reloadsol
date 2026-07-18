import { describe, expect, it, vi } from "vitest";
import { VersionedTransaction } from "@solana/web3.js";
import { signTransactionsWithFallback } from "@/utils/swap-executor";
import { isWalletUserRejection } from "@/utils/wallet-rejection";

function fakeTx(): VersionedTransaction {
  return {} as VersionedTransaction;
}

describe("isWalletUserRejection", () => {
  it("detects common wallet cancel messages", () => {
    expect(isWalletUserRejection(new Error("User rejected the request"))).toBe(
      true,
    );
    expect(isWalletUserRejection("User denied transaction signature")).toBe(
      true,
    );
    expect(isWalletUserRejection(new Error("batch not supported"))).toBe(
      false,
    );
  });
});

describe("signTransactionsWithFallback", () => {
  it("rethrows user rejection and does not call one-by-one fallback", async () => {
    const txs = [fakeTx(), fakeTx()];
    const signAll = vi
      .fn()
      .mockRejectedValue(new Error("User rejected the request"));
    const signOne = vi.fn();

    await expect(
      signTransactionsWithFallback(txs, signAll, signOne),
    ).rejects.toThrow(/User rejected/);

    expect(signAll).toHaveBeenCalledTimes(1);
    expect(signAll).toHaveBeenCalledWith(txs);
    expect(signOne).not.toHaveBeenCalled();
  });

  it("falls back to one-by-one on non-rejection batch failure", async () => {
    const tx0 = fakeTx();
    const tx1 = fakeTx();
    const signed0 = fakeTx();
    const signed1 = fakeTx();
    const signAll = vi
      .fn()
      .mockRejectedValue(new Error("signAllTransactions is not supported"));
    const signOne = vi
      .fn()
      .mockResolvedValueOnce(signed0)
      .mockResolvedValueOnce(signed1);

    const result = await signTransactionsWithFallback(
      [tx0, tx1],
      signAll,
      signOne,
    );

    expect(result).toEqual([signed0, signed1]);
    expect(signOne).toHaveBeenCalledTimes(2);
    expect(signOne).toHaveBeenNthCalledWith(1, tx0);
    expect(signOne).toHaveBeenNthCalledWith(2, tx1);
  });
});
