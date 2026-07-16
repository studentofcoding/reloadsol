import { describe, expect, it, vi, beforeEach } from "vitest";
import { VersionedTransaction, type Connection } from "@solana/web3.js";
import { RaptorAPIError } from "@/utils/solanatracker-raptor";

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
    sendRaptorTransactionDirect: vi.fn(),
    getRaptorTransactionStatusSafe: vi.fn(),
  };
});

vi.mock("@/utils/jupiter-lite-swap", () => ({
  prepareJupiterLiteSwap: vi.fn(),
  fetchJupiterLiteQuoteDirect: vi.fn(),
  fetchJupiterLiteQuote: vi.fn(),
  mapJupiterLiteQuoteToSwapQuote: vi.fn(),
}));

vi.mock("@/utils/shyft-transaction", () => ({
  sendShyftTransactionDirect: vi.fn(),
  sendShyftTransaction: vi.fn(),
  sendShyftManyTransactionsDirect: vi.fn(),
  sendShyftManyTransactions: vi.fn(),
}));

import {
  fetchRaptorQuoteAndSwapDirect,
  sendRaptorTransactionDirect,
  getRaptorTransactionStatusSafe,
} from "@/utils/solanatracker-raptor";
import { getTradeProvider } from "@/utils/trade-provider";
import { prepareJupiterLiteSwap } from "@/utils/jupiter-lite-swap";
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

  it("prepareSwapTransaction uses Raptor on shyft stack when Raptor succeeds", async () => {
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

    const prepared = await prepareSwapTransaction(PREPARE_PARAMS);

    expect(prepared.provider).toBe("raptor");
    expect(prepareJupiterLiteSwap).not.toHaveBeenCalled();
  });

  it("prepareSwapTransaction falls back to Jupiter Lite when Raptor fails", async () => {
    vi.mocked(fetchRaptorQuoteAndSwapDirect).mockRejectedValue(
      new RaptorAPIError("Raptor down", 502),
    );
    vi.mocked(prepareJupiterLiteSwap).mockResolvedValue({
      swapTransaction: "bGl0ZQ==",
      outAmount: "500",
      lastValidBlockHeight: 456,
      quoteResponse: {} as never,
    });

    const prepared = await prepareSwapTransaction(PREPARE_PARAMS);

    expect(prepared.provider).toBe("jupiter_lite");
    expect(prepareJupiterLiteSwap).toHaveBeenCalled();
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

  it("confirmSwapSignaturesBatch polls Raptor when checkViaRaptor even if via is rpc", async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue({
      status: "confirmed",
    });

    const connection = {
      getSignatureStatuses: vi.fn(),
    } as never;

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
