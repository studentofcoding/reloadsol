import { describe, expect, it, vi, beforeEach } from "vitest";
import { VersionedTransaction, type Connection } from "@solana/web3.js";

vi.mock("@/utils/rpc-rate-limit", () => ({
  waitForRpcRateLimit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/trade-provider", () => ({
  getTradeProvider: vi.fn(() => "shyft" as const),
}));

vi.mock("@/utils/solanatracker-raptor", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/solanatracker-raptor")>();
  return {
    ...actual,
    fetchRaptorQuoteAndSwapDirect: vi.fn(),
    fetchRaptorQuoteDirect: vi.fn(),
    fetchRaptorQuote: vi.fn(),
    sendRaptorTransactionDirect: vi.fn(),
    getRaptorTransactionStatusSafe: vi.fn(),
  };
});

vi.mock("@/utils/jupiter-lite-swap", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/jupiter-lite-swap")>();
  return {
    ...actual,
    prepareJupiterLiteSwap: vi.fn(),
    fetchJupiterLiteQuoteDirect: vi.fn(),
    fetchJupiterLiteQuote: vi.fn(),
  };
});

vi.mock("@/utils/jupiter-swap-quote", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/jupiter-swap-quote")>();
  return {
    ...actual,
    prepareJupiterSwapOrder: vi.fn(),
    fetchJupiterSwapQuoteDirect: vi.fn(),
    fetchJupiterSwapQuote: vi.fn(),
    executeJupiterSwapDirect: vi.fn(),
    executeJupiterSwap: vi.fn(),
  };
});

vi.mock("@/utils/shyft-transaction", () => ({
  sendShyftTransactionDirect: vi.fn(),
  sendShyftTransaction: vi.fn(),
  sendShyftManyTransactionsDirect: vi.fn(),
  sendShyftManyTransactions: vi.fn(),
}));

import {
  fetchRaptorQuoteAndSwapDirect,
  fetchRaptorQuoteDirect,
  sendRaptorTransactionDirect,
  getRaptorTransactionStatusSafe,
} from "@/utils/solanatracker-raptor";
import { getTradeProvider } from "@/utils/trade-provider";
import {
  prepareJupiterLiteSwap,
  fetchJupiterLiteQuoteDirect,
} from "@/utils/jupiter-lite-swap";
import {
  prepareJupiterSwapOrder,
  fetchJupiterSwapQuoteDirect,
  executeJupiterSwapDirect,
} from "@/utils/jupiter-swap-quote";
import { autoPriorityFeeLamports } from "@/utils/priority-fee";
import { sendShyftTransactionDirect, sendShyftManyTransactionsDirect } from "@/utils/shyft-transaction";
import {
  prepareSwapTransaction,
  submitSignedSwap,
  submitSignedSwapBatch,
  confirmSwapSignaturesBatch,
} from "@/utils/swap-executor";

const PREPARE_PARAMS = {
  userPublicKey: "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV",
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "1000000",
  slippageBps: 50,
  direct: true,
};

describe("swap-executor shyft provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTradeProvider).mockReturnValue("shyft");
  });

  it("desk prepare is one Jupiter V2 order and does not quote Raptor", async () => {
    vi.mocked(prepareJupiterSwapOrder).mockResolvedValue({
      swapTransaction: "c3dhcA==",
      outAmount: "600",
      lastValidBlockHeight: 789,
      requestId: "req-1",
      priceImpact: 0.002,
    });

    const prepared = await prepareSwapTransaction({
      ...PREPARE_PARAMS,
      priorityFeeLamports: autoPriorityFeeLamports({
        level: "high",
        maxLamports: 3_000_000,
      }),
    });

    expect(prepared.provider).toBe("jupiter_swap");
    expect(prepared.requestId).toBe("req-1");
    expect(prepared.swapTransaction).toBe("c3dhcA==");
    expect(prepareJupiterSwapOrder).toHaveBeenCalledTimes(1);
    expect(prepareJupiterSwapOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        userPublicKey: PREPARE_PARAMS.userPublicKey,
        priorityFeeLamports: autoPriorityFeeLamports({
          level: "high",
          maxLamports: 3_000_000,
        }),
      }),
    );
    expect(fetchJupiterSwapQuoteDirect).not.toHaveBeenCalled();
    expect(fetchRaptorQuoteDirect).not.toHaveBeenCalled();
    expect(fetchRaptorQuoteAndSwapDirect).not.toHaveBeenCalled();
    expect(prepareJupiterLiteSwap).not.toHaveBeenCalled();
  });

  it("desk prepare falls back to Lite only when V2 /order fails", async () => {
    vi.mocked(prepareJupiterSwapOrder).mockRejectedValue(
      new Error("Jupiter order HTTP 500"),
    );
    vi.mocked(prepareJupiterLiteSwap).mockResolvedValue({
      swapTransaction: "bGl0ZQ==",
      outAmount: "500",
      lastValidBlockHeight: 456,
      quoteResponse: { priceImpactPct: "0.01" } as never,
    });

    const prepared = await prepareSwapTransaction(PREPARE_PARAMS);

    expect(prepared.provider).toBe("jupiter_lite");
    expect(prepareJupiterLiteSwap).toHaveBeenCalledTimes(1);
    expect(fetchRaptorQuoteAndSwapDirect).not.toHaveBeenCalled();
    expect(fetchRaptorQuoteDirect).not.toHaveBeenCalled();
  });

  it("desk prepare rejects a high-impact V2 order without calling Lite", async () => {
    vi.mocked(prepareJupiterSwapOrder).mockResolvedValue({
      swapTransaction: "c3dhcA==",
      outAmount: "600",
      priceImpact: 0.5,
      requestId: "req-high",
    });

    await expect(prepareSwapTransaction(PREPARE_PARAMS)).rejects.toThrow(
      /No swap route within/,
    );
    expect(prepareJupiterLiteSwap).not.toHaveBeenCalled();
    expect(fetchRaptorQuoteAndSwapDirect).not.toHaveBeenCalled();
  });

  it("prepareSwapTransaction with maxHops skips parallel pick (arb path)", async () => {
    vi.mocked(fetchRaptorQuoteAndSwapDirect).mockResolvedValue({
      quote: {
        inputMint: PREPARE_PARAMS.inputMint,
        outputMint: PREPARE_PARAMS.outputMint,
        amountIn: "1000000",
        amountOut: "500",
        minAmountOut: "490",
        priceImpact: 0,
        slippageBps: 50,
      },
      swapTransaction: "dGVzdA==",
      lastValidBlockHeight: 123,
    });

    const prepared = await prepareSwapTransaction({
      ...PREPARE_PARAMS,
      maxHops: 3,
    });

    expect(prepared.provider).toBe("raptor");
    expect(fetchRaptorQuoteDirect).not.toHaveBeenCalled();
    expect(fetchJupiterLiteQuoteDirect).not.toHaveBeenCalled();
    expect(fetchJupiterSwapQuoteDirect).not.toHaveBeenCalled();
    expect(fetchRaptorQuoteAndSwapDirect).toHaveBeenCalled();
    expect(prepareJupiterSwapOrder).not.toHaveBeenCalled();
    expect(prepareJupiterLiteSwap).not.toHaveBeenCalled();
  });

  it("submitSignedSwap prefers Jupiter /execute when requestId is present", async () => {
    vi.mocked(executeJupiterSwapDirect).mockResolvedValue({
      signature: "jup-sig",
    });

    const tx = {
      serialize: () => new Uint8Array([1, 2, 3]),
    } as unknown as VersionedTransaction;
    const sendTransaction = vi.fn();
    const connection = { sendTransaction } as unknown as Connection;

    const result = await submitSignedSwap({
      signedTx: tx,
      prepared: {
        provider: "jupiter_swap",
        swapTransaction: "x",
        requestId: "req-1",
      },
      connection,
      direct: true,
    });

    expect(result).toEqual({
      signature: "jup-sig",
      via: "jupiter",
      checkViaRaptor: false,
      landed: true,
    });
    expect(executeJupiterSwapDirect).toHaveBeenCalledWith({
      signedTransaction: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"),
      requestId: "req-1",
    });
    expect(sendShyftTransactionDirect).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("submitSignedSwap falls back to Shyft when Jupiter /execute fails", async () => {
    vi.mocked(executeJupiterSwapDirect).mockRejectedValue(new Error("execute down"));
    vi.mocked(sendShyftTransactionDirect).mockResolvedValue({
      success: true,
      signature: "shyft-sig",
    });

    const tx = {
      serialize: () => Buffer.from("signed-bytes"),
    } as unknown as VersionedTransaction;
    const connection = { sendTransaction: vi.fn() } as unknown as Connection;

    const result = await submitSignedSwap({
      signedTx: tx,
      prepared: {
        provider: "jupiter_swap",
        swapTransaction: "x",
        requestId: "req-1",
      },
      connection,
      direct: true,
    });

    expect(result).toEqual({ signature: "shyft-sig", via: "shyft" });
    expect(connection.sendTransaction).not.toHaveBeenCalled();
  });

  it("submitSignedSwap returns via shyft when Shyft send succeeds", async () => {
    vi.mocked(sendShyftTransactionDirect).mockResolvedValue({
      success: true,
      signature: "shyft-sig",
    });

    const tx = {
      serialize: () => Buffer.from("signed-bytes"),
    } as unknown as VersionedTransaction;

    const sendTransaction = vi.fn();
    const connection = { sendTransaction } as unknown as Connection;

    const result = await submitSignedSwap({
      signedTx: tx,
      prepared: { provider: "raptor", swapTransaction: "x" },
      connection,
      direct: true,
    });

    expect(result).toEqual({ signature: "shyft-sig", via: "shyft" });
    expect(connection.sendTransaction).not.toHaveBeenCalled();
  });

  it("confirmSwapSignaturesBatch skips Raptor poll for shyft sends", async () => {
    const connection = {
      getSignatureStatuses: vi.fn(async () => ({
        value: [{ confirmationStatus: "confirmed" }],
      })),
    } as never;

    const results = await confirmSwapSignaturesBatch(
      [{ signature: "sig-shyft", via: "shyft", direct: true }],
      connection,
      { intervalMs: 10, deadlineMs: 1000 },
    );

    expect(getRaptorTransactionStatusSafe).not.toHaveBeenCalled();
    expect(results.get("sig-shyft")).toBeNull();
  });

  it("submitSignedSwapBatch uses send_many for shyft when batch size > 1", async () => {
    vi.mocked(sendShyftManyTransactionsDirect).mockResolvedValue({
      success: true,
      results: [
        { id: 1, signature: "sig-a", status: "confirmed" },
        { id: 2, signature: "sig-b", status: "confirmed" },
      ],
    });

    const makeTx = () =>
      ({
        serialize: () => Buffer.from("signed-bytes"),
      }) as unknown as VersionedTransaction;

    const connection = { sendTransaction: vi.fn() } as unknown as Connection;

    const results = await submitSignedSwapBatch(
      [
        { signedTx: makeTx(), prepared: { provider: "raptor", swapTransaction: "a" }, index: 0 },
        { signedTx: makeTx(), prepared: { provider: "raptor", swapTransaction: "b" }, index: 1 },
      ],
      connection,
      true,
    );

    expect(sendShyftManyTransactionsDirect).toHaveBeenCalledTimes(1);
    expect(sendShyftTransactionDirect).not.toHaveBeenCalled();
    expect(results).toEqual([
      { index: 0, success: true, signature: "sig-a", via: "shyft" },
      { index: 1, success: true, signature: "sig-b", via: "shyft" },
    ]);
  });
});

describe("swap-executor raptor provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTradeProvider).mockReturnValue("raptor");
  });

  it("submitSignedSwap sends via RPC and skips Raptor send API", async () => {
    const tx = {
      serialize: () => Buffer.from("signed-bytes"),
    } as unknown as VersionedTransaction;

    const sendTransaction = vi.fn().mockResolvedValue("rpc-sig");
    const connection = { sendTransaction } as unknown as Connection;

    const result = await submitSignedSwap({
      signedTx: tx,
      prepared: { provider: "raptor", swapTransaction: "x" },
      connection,
      direct: true,
    });

    expect(result).toEqual({
      signature: "rpc-sig",
      via: "rpc",
      checkViaRaptor: true,
    });
    expect(sendTransaction).toHaveBeenCalledWith(tx, {
      skipPreflight: true,
      maxRetries: 2,
    });
    expect(sendRaptorTransactionDirect).not.toHaveBeenCalled();
  });

  it("submitSignedSwap falls back to RPC when Jupiter /execute fails on the raptor stack", async () => {
    vi.mocked(executeJupiterSwapDirect).mockRejectedValue(new Error("execute down"));

    const tx = {
      serialize: () => new Uint8Array([9, 9]),
    } as unknown as VersionedTransaction;
    const sendTransaction = vi.fn().mockResolvedValue("rpc-sig");
    const connection = { sendTransaction } as unknown as Connection;

    const result = await submitSignedSwap({
      signedTx: tx,
      prepared: {
        provider: "jupiter_swap",
        swapTransaction: "x",
        requestId: "req-1",
      },
      connection,
      direct: true,
    });

    expect(result).toEqual({
      signature: "rpc-sig",
      via: "rpc",
      checkViaRaptor: false,
    });
    expect(sendTransaction).toHaveBeenCalled();
    expect(sendRaptorTransactionDirect).not.toHaveBeenCalled();
  });

  it("submitSignedSwap skips Raptor confirm poll when the tx was built by Lite", async () => {
    const tx = {
      serialize: () => Buffer.from("signed-bytes"),
    } as unknown as VersionedTransaction;

    const sendTransaction = vi.fn().mockResolvedValue("rpc-sig");
    const connection = { sendTransaction } as unknown as Connection;

    const result = await submitSignedSwap({
      signedTx: tx,
      prepared: { provider: "jupiter_lite", swapTransaction: "x" },
      connection,
      direct: true,
    });

    expect(result.checkViaRaptor).toBe(false);
  });

  it("submitSignedSwapBatch uses send_many_txns on raptor stack when batch size > 1", async () => {
    vi.mocked(sendShyftManyTransactionsDirect).mockResolvedValue({
      success: true,
      results: [
        { id: 1, signature: "sig-a", status: "confirmed" },
        { id: 2, signature: "sig-b", status: "confirmed" },
      ],
    });

    const makeTx = () =>
      ({
        serialize: () => Buffer.from("signed-bytes"),
      }) as unknown as VersionedTransaction;

    const sendTransaction = vi.fn();
    const connection = { sendTransaction } as unknown as Connection;

    const results = await submitSignedSwapBatch(
      [
        { signedTx: makeTx(), prepared: { provider: "raptor", swapTransaction: "a" }, index: 0 },
        { signedTx: makeTx(), prepared: { provider: "raptor", swapTransaction: "b" }, index: 1 },
      ],
      connection,
      true,
    );

    expect(sendShyftManyTransactionsDirect).toHaveBeenCalledTimes(1);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(results).toEqual([
      { index: 0, success: true, signature: "sig-a", via: "shyft" },
      { index: 1, success: true, signature: "sig-b", via: "shyft" },
    ]);
  });

  it("confirmSwapSignaturesBatch polls Raptor when checkViaRaptor even if via is rpc", async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue({
      status: "confirmed",
    });

    const connection = {
      getSignatureStatuses: vi.fn(),
    } as unknown as Connection;

    const results = await confirmSwapSignaturesBatch(
      [{ signature: "sig-rpc", via: "rpc", checkViaRaptor: true, direct: true }],
      connection,
      { intervalMs: 10, deadlineMs: 1000 },
    );

    expect(getRaptorTransactionStatusSafe).toHaveBeenCalledWith("sig-rpc", {
      direct: true,
    });
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
    expect(results.get("sig-rpc")).toBeNull();
  });
});
