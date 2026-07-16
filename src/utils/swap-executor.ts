import { Connection, VersionedTransaction } from "@solana/web3.js";
import {
  fetchRaptorQuoteAndSwap,
  fetchRaptorQuoteAndSwapDirect,
  fetchRaptorQuote,
  fetchRaptorQuoteDirect,
  getRaptorTransactionStatusSafe,
  RaptorAPIError,
  type RaptorQuoteAndSwapParams,
  type RaptorQuoteResponse,
} from "@/utils/solanatracker-raptor";
import {
  prepareJupiterLiteSwap,
  fetchJupiterLiteQuote,
  fetchJupiterLiteQuoteDirect,
  mapJupiterLiteQuoteToSwapQuote,
} from "@/utils/jupiter-lite-swap";
import {
  sendShyftTransaction,
  sendShyftTransactionDirect,
  sendShyftManyTransactions,
  sendShyftManyTransactionsDirect,
} from "@/utils/shyft-transaction";
import { getTradeProvider } from "@/utils/trade-provider";
import { waitForRpcRateLimit } from "@/utils/rpc-rate-limit";
import {
  getConfirmTransport,
  getConfirmWsUrl,
  type ConfirmTransport,
} from "@/utils/confirm-transport";
import { confirmSignaturesViaWs } from "@/utils/ws-confirm";
import type { SwapQuote, SwapTransaction } from "@/types";

export type SwapProvider = "raptor" | "jupiter_lite";

export type SwapSendVia = "raptor" | "shyft" | "rpc";

export type PreparedSwap = {
  provider: SwapProvider;
  swapTransaction: string;
  outAmount?: string;
  lastValidBlockHeight?: number;
};

export type PrepareSwapParams = {
  userPublicKey: string;
  inputMint: string;
  outputMint: string;
  amount: string | number;
  slippageBps: number;
  priorityFeeLamports?: number;
  feeAccount?: string;
  feeBps?: number;
  /** Server-side routes set true to call Raptor directly */
  direct?: boolean;
  connection?: Connection;
};

function mapRaptorQuoteToSwapQuote(
  quote: RaptorQuoteResponse,
  amount: number,
): SwapQuote {
  return {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.amountIn,
    outAmount: quote.amountOut,
    otherAmountThreshold: quote.minAmountOut,
    swapMode: "ExactIn",
    slippageBps: quote.slippageBps,
    priceImpactPct: String(quote.priceImpact ?? 0),
    routePlan: (quote.routePlan as unknown[]) ?? [],
  };
}

async function prepareRaptorSwap(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  const raptorParams: RaptorQuoteAndSwapParams = {
    userPublicKey: params.userPublicKey,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: params.slippageBps,
    priorityFeeLamports: params.priorityFeeLamports,
    feeAccount: params.feeAccount,
    feeBps: params.feeBps,
  };

  const useDirect = params.direct ?? typeof window === "undefined";
  const swapResult = useDirect
    ? await fetchRaptorQuoteAndSwapDirect(raptorParams)
    : await fetchRaptorQuoteAndSwap(raptorParams);

  if (!swapResult.swapTransaction) {
    throw new RaptorAPIError("Raptor returned no swapTransaction");
  }

  return {
    provider: "raptor",
    swapTransaction: swapResult.swapTransaction,
    outAmount: swapResult.quote.amountOut,
    lastValidBlockHeight: swapResult.lastValidBlockHeight,
  };
}

async function prepareJupiterLiteSwapPrepared(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  const lite = await prepareJupiterLiteSwap({
    userPublicKey: params.userPublicKey,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: params.slippageBps,
    priorityFeeLamports: params.priorityFeeLamports,
    direct: params.direct,
  });

  return {
    provider: "jupiter_lite",
    swapTransaction: lite.swapTransaction,
    outAmount: lite.outAmount,
    lastValidBlockHeight: lite.lastValidBlockHeight,
  };
}

/** Shyft stack: Raptor build first, Jupiter Lite on failure. */
async function prepareShyftStackSwap(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  try {
    return await prepareRaptorSwap(params);
  } catch (raptorError) {
    console.warn(
      "Raptor build failed on shyft stack, falling back to Jupiter Lite:",
      raptorError,
    );
    return prepareJupiterLiteSwapPrepared(params);
  }
}

/** Quote-and-swap — builds unsigned swap transaction. */
export async function prepareSwapTransaction(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  if (getTradeProvider() === "shyft") {
    return prepareShyftStackSwap(params);
  }
  return prepareRaptorSwap(params);
}

/** Quote for UI. */
export async function fetchSwapQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
  direct?: boolean,
): Promise<SwapQuote | null> {
  try {
    if (amount <= 0) return null;
    const useDirect = direct ?? typeof window === "undefined";

    if (getTradeProvider() === "shyft") {
      try {
        const quote = useDirect
          ? await fetchRaptorQuoteDirect(
              inputMint,
              outputMint,
              String(amount),
              slippageBps,
            )
          : await fetchRaptorQuote(
              inputMint,
              outputMint,
              String(amount),
              slippageBps,
            );
        return mapRaptorQuoteToSwapQuote(quote, amount);
      } catch (raptorError) {
        console.warn(
          "Raptor quote failed on shyft stack, falling back to Jupiter Lite:",
          raptorError,
        );
        const liteQuote = useDirect
          ? await fetchJupiterLiteQuoteDirect(
              inputMint,
              outputMint,
              String(amount),
              slippageBps,
            )
          : await fetchJupiterLiteQuote(
              inputMint,
              outputMint,
              String(amount),
              slippageBps,
            );
        return mapJupiterLiteQuoteToSwapQuote(liteQuote);
      }
    }

    const quote = useDirect
      ? await fetchRaptorQuoteDirect(
          inputMint,
          outputMint,
          String(amount),
          slippageBps,
        )
      : await fetchRaptorQuote(
          inputMint,
          outputMint,
          String(amount),
          slippageBps,
        );
    return mapRaptorQuoteToSwapQuote(quote, amount);
  } catch (error) {
    console.error("Error getting swap quote:", error);
    return null;
  }
}

export async function buildPreparedSwap(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  return prepareSwapTransaction(params);
}

/** Build swap tx via Raptor. */
export async function buildSwapTransaction(
  quote: SwapQuote,
  userPublicKey: string,
  priorityFeeLamports = 0,
  options?: {
    direct?: boolean;
    feeAccount?: string;
    feeBps?: number;
    connection?: Connection;
  },
): Promise<SwapTransaction | null> {
  try {
    const prepared = await prepareSwapTransaction({
      userPublicKey,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      amount: quote.inAmount,
      slippageBps: quote.slippageBps,
      priorityFeeLamports,
      feeAccount: options?.feeAccount,
      feeBps: options?.feeBps,
      direct: options?.direct,
      connection: options?.connection,
    });

    return {
      swapTransaction: prepared.swapTransaction,
      lastValidBlockHeight: prepared.lastValidBlockHeight ?? 0,
    };
  } catch (error) {
    console.error("Error building swap transaction:", error);
    return null;
  }
}

export type SubmitSignedSwapParams = {
  signedTx: VersionedTransaction;
  prepared: PreparedSwap;
  connection: Connection;
  direct?: boolean;
};

export type SubmitSignedSwapResult = {
  signature: string;
  via: SwapSendVia;
  /** Poll Raptor status API even when send went via RPC. */
  checkViaRaptor?: boolean;
};

/** Submit signed swap — Shyft API (with RPC fallback) or RPC-only for Raptor. */
export async function submitSignedSwap(
  params: SubmitSignedSwapParams,
): Promise<SubmitSignedSwapResult> {
  const useDirect = params.direct ?? typeof window === "undefined";

  if (getTradeProvider() === "shyft") {
    const signedBase64 = Buffer.from(params.signedTx.serialize()).toString("base64");
    try {
      const sendResult = useDirect
        ? await sendShyftTransactionDirect(signedBase64)
        : await sendShyftTransaction(signedBase64);

      if (sendResult.success && sendResult.signature) {
        return { signature: sendResult.signature, via: "shyft" };
      }
    } catch (shyftError) {
      console.warn("Shyft send failed, falling back to RPC:", shyftError);
    }

    await waitForRpcRateLimit();
    const signature = await params.connection.sendTransaction(params.signedTx, {
      skipPreflight: true,
      maxRetries: 2,
    });
    return { signature, via: "rpc" };
  }

  // Raptor stack: send via RPC only; confirm still uses Raptor status API.
  await waitForRpcRateLimit();
  const signature = await params.connection.sendTransaction(params.signedTx, {
    skipPreflight: true,
    maxRetries: 2,
  });
  return { signature, via: "rpc", checkViaRaptor: true };
}

export type SubmitSignedSwapBatchItem = {
  signedTx: VersionedTransaction;
  prepared: PreparedSwap;
  index: number;
};

export type SubmitSignedSwapBatchResult =
  | {
      index: number;
      success: true;
      signature: string;
      via: SwapSendVia;
      checkViaRaptor?: boolean;
    }
  | { index: number; success: false; error: unknown };

async function rpcSendFallback(
  signedTx: VersionedTransaction,
  connection: Connection,
): Promise<string> {
  await waitForRpcRateLimit();
  return connection.sendTransaction(signedTx, {
    skipPreflight: true,
    maxRetries: 2,
  });
}

async function submitShyftManyBatch(
  items: SubmitSignedSwapBatchItem[],
  connection: Connection,
  useDirect: boolean,
): Promise<SubmitSignedSwapBatchResult[]> {
  const encoded = items.map((item) =>
    Buffer.from(item.signedTx.serialize()).toString("base64"),
  );

  const resolveItem = async (
    item: SubmitSignedSwapBatchItem,
    row: { signature?: string } | undefined,
    batchError?: unknown,
  ): Promise<SubmitSignedSwapBatchResult> => {
    if (row?.signature) {
      return {
        index: item.index,
        success: true,
        signature: row.signature,
        via: "shyft",
      };
    }
    try {
      const signature = await rpcSendFallback(item.signedTx, connection);
      return { index: item.index, success: true, signature, via: "rpc" };
    } catch (error) {
      return {
        index: item.index,
        success: false,
        error: batchError ?? error,
      };
    }
  };

  try {
    const manyResult = useDirect
      ? await sendShyftManyTransactionsDirect(encoded)
      : await sendShyftManyTransactions(encoded);

    return Promise.all(
      items.map((item, i) => {
        const row =
          manyResult.results.find((r) => r.id === i + 1) ?? manyResult.results[i];
        return resolveItem(item, row);
      }),
    );
  } catch (manyError) {
    console.warn("Shyft send_many failed, falling back to RPC per tx:", manyError);
    return Promise.all(
      items.map((item) => resolveItem(item, undefined, manyError)),
    );
  }
}

/** Batch submit — Shyft uses send_many_txns when count > 1; Raptor uses parallel single sends. */
export async function submitSignedSwapBatch(
  items: SubmitSignedSwapBatchItem[],
  connection: Connection,
  direct?: boolean,
): Promise<SubmitSignedSwapBatchResult[]> {
  if (items.length === 0) return [];

  const useDirect = direct ?? typeof window === "undefined";

  if (getTradeProvider() === "shyft") {
    if (items.length === 1) {
      try {
        const sendResult = await submitSignedSwap({
          signedTx: items[0].signedTx,
          prepared: items[0].prepared,
          connection,
          direct,
        });
        return [
          {
            index: items[0].index,
            success: true,
            signature: sendResult.signature,
            via: sendResult.via,
            checkViaRaptor: sendResult.checkViaRaptor,
          },
        ];
      } catch (error) {
        return [{ index: items[0].index, success: false, error }];
      }
    }
    return submitShyftManyBatch(items, connection, useDirect);
  }

  return runWithConcurrency(
    items,
    getTradeSendConcurrency(),
    async (item) => {
      try {
        const sendResult = await submitSignedSwap({
          signedTx: item.signedTx,
          prepared: item.prepared,
          connection,
          direct,
        });
        return {
          index: item.index,
          success: true as const,
          signature: sendResult.signature,
          via: sendResult.via,
          checkViaRaptor: sendResult.checkViaRaptor,
        };
      } catch (error) {
        return { index: item.index, success: false as const, error };
      }
    },
  );
}

const CONFIRM_POLL_INTERVAL_MS = 3000;
const CONFIRM_DEADLINE_MS = 45_000;
const RAPTOR_CONFIRM_CONCURRENCY = 2;
const MAX_CONSECUTIVE_RPC_FAILURES = 3;

export function getTradeSendConcurrency(): number {
  const n = Number(process.env.TRADE_SEND_CONCURRENCY ?? 4);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

/** Run async tasks with a fixed concurrency cap. */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export type ConfirmSwapSignatureParams = {
  signature: string;
  via: SwapSendVia;
  connection: Connection;
  /** Poll Raptor status API (defaults to via === "raptor"). */
  checkViaRaptor?: boolean;
  /** Unused for confirm (kept for caller compatibility). */
  lastValidBlockHeight?: number;
  /** Unused for confirm (kept for caller compatibility). */
  blockhash?: string;
  direct?: boolean;
};

type ParsedSignatureStatus = "confirmed" | "pending";

/** Throws on on-chain error; `processed` counts as landed. */
function parseSignatureStatus(
  status: { err?: unknown; confirmationStatus?: string | null } | null,
): ParsedSignatureStatus {
  if (status?.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
  }
  const level = status?.confirmationStatus;
  return level === "processed" || level === "confirmed" || level === "finalized"
    ? "confirmed"
    : "pending";
}

export type BatchConfirmItem = Omit<ConfirmSwapSignatureParams, "connection">;

export type ConfirmBatchOptions = {
  intervalMs?: number;
  deadlineMs?: number;
  /** Dev toggle: 'ws' tries signatureSubscribe first, then falls back to polling. */
  transport?: ConfirmTransport;
};

/** WS-first confirm (dev toggle): resolve what WS can, leave the rest pending. */
async function tryWsConfirm(
  pendingItems: Map<string, BatchConfirmItem>,
  connection: Connection,
  results: Map<string, string | null>,
  deadline: number,
): Promise<void> {
  const wsUrl = getConfirmWsUrl();
  if (!wsUrl) return;

  const checkNow = async (sigs: string[]) => {
    const snapshot = new Map<string, string | null>();
    await waitForRpcRateLimit();
    const response = await connection.getSignatureStatuses(sigs, {
      searchTransactionHistory: true,
    });
    sigs.forEach((signature, index) => {
      try {
        if (parseSignatureStatus(response.value[index]) === "confirmed") {
          snapshot.set(signature, null);
        }
      } catch (error) {
        snapshot.set(
          signature,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
    return snapshot;
  };

  // Leave ~10s of the deadline for the polling fallback (catches failed/expired).
  const wsTimeoutMs = Math.max(deadline - Date.now() - 10_000, 5_000);
  const wsResults = await confirmSignaturesViaWs(
    Array.from(pendingItems.keys()),
    wsUrl,
    { timeoutMs: wsTimeoutMs, checkNow },
  );

  for (const [signature, error] of Array.from(wsResults.entries())) {
    results.set(signature, error);
    pendingItems.delete(signature);
  }
}

/**
 * Confirm signatures with one shared poll loop:
 * - Raptor status (RPC-free) is primary when `via: 'raptor'` or `checkViaRaptor`.
 * - One batched getSignatureStatuses call per tick covers everything else.
 * Returns sig -> null (confirmed) or error message.
 */
export async function confirmSwapSignaturesBatch(
  items: BatchConfirmItem[],
  connection: Connection,
  options?: ConfirmBatchOptions,
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  if (items.length === 0) return results;

  const intervalMs = options?.intervalMs ?? CONFIRM_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options?.deadlineMs ?? CONFIRM_DEADLINE_MS);

  const pending = new Map<string, BatchConfirmItem>();
  const raptorEligible = new Set<string>();
  for (const item of items) {
    pending.set(item.signature, item);
    if (item.via === "raptor" || item.checkViaRaptor) {
      raptorEligible.add(item.signature);
    }
  }

  // Dev-only WS transport: signatureSubscribe first, poll only leftovers.
  const transport = options?.transport ?? getConfirmTransport();
  if (transport === "ws" && pending.size > 0) {
    await tryWsConfirm(pending, connection, results, deadline);
    if (pending.size === 0) return results;
  }

  let consecutiveRpcFailures = 0;

  while (pending.size > 0) {
    // Phase A: Raptor tracks its own sends; poll it first, no RPC budget spent.
    const raptorItems = Array.from(pending.values()).filter((item) =>
      raptorEligible.has(item.signature),
    );
    if (raptorItems.length > 0) {
      await runWithConcurrency(
        raptorItems,
        RAPTOR_CONFIRM_CONCURRENCY,
        async (item) => {
          try {
            const status = await getRaptorTransactionStatusSafe(item.signature, {
              direct: item.direct,
            });
            if (status === null) {
              raptorEligible.delete(item.signature);
            } else if (status.status === "confirmed") {
              results.set(item.signature, null);
              pending.delete(item.signature);
            } else if (
              status.status === "failed" ||
              status.status === "expired"
            ) {
              results.set(item.signature, `Raptor transaction ${status.status}`);
              pending.delete(item.signature);
            }
          } catch {
            // Raptor unreachable — fall back to RPC-only for this sig.
            raptorEligible.delete(item.signature);
          }
        },
      );
      if (pending.size === 0) break;
    }

    // Phase B: one batched RPC status check for all still-pending sigs.
    const pendingSigs = Array.from(pending.keys());
    try {
      await waitForRpcRateLimit();
      const response = await connection.getSignatureStatuses(pendingSigs, {
        searchTransactionHistory: true,
      });
      consecutiveRpcFailures = 0;

      pendingSigs.forEach((signature, index) => {
        try {
          if (parseSignatureStatus(response.value[index]) === "confirmed") {
            results.set(signature, null);
            pending.delete(signature);
          }
        } catch (error) {
          results.set(
            signature,
            error instanceof Error ? error.message : String(error),
          );
          pending.delete(signature);
        }
      });
    } catch (error) {
      consecutiveRpcFailures += 1;
      if (consecutiveRpcFailures >= MAX_CONSECUTIVE_RPC_FAILURES) {
        const message = error instanceof Error ? error.message : String(error);
        for (const signature of Array.from(pending.keys())) {
          results.set(signature, `RPC confirmation unavailable: ${message}`);
        }
        return results;
      }
    }

    if (pending.size === 0 || Date.now() + intervalMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  for (const signature of Array.from(pending.keys())) {
    results.set(signature, `Transaction confirmation timeout for ${signature}`);
  }
  return results;
}

export type WaitForSwapConfirmationParams = ConfirmSwapSignatureParams & {
  maxAttempts?: number;
  intervalMs?: number;
};

/** Single-signature confirm — delegates to the batch loop. */
export async function waitForSwapConfirmation(
  params: WaitForSwapConfirmationParams,
): Promise<void> {
  const intervalMs = params.intervalMs ?? CONFIRM_POLL_INTERVAL_MS;
  const deadlineMs =
    params.maxAttempts != null ? params.maxAttempts * intervalMs : undefined;

  const { connection, maxAttempts: _max, intervalMs: _int, ...item } = params;
  const resultMap = await confirmSwapSignaturesBatch([item], connection, {
    intervalMs,
    deadlineMs,
  });

  const error = resultMap.get(params.signature);
  if (error) {
    if (error.startsWith("Raptor transaction ")) {
      throw new RaptorAPIError(error, 400);
    }
    throw new Error(error);
  }
}

/** Hybrid confirm wrapper for callers. */
export async function confirmSwapSignature(
  params: ConfirmSwapSignatureParams,
): Promise<void> {
  await waitForSwapConfirmation(params);
}

export type PreparedSwapMeta = PreparedSwap;

export async function prepareBulkSwapTransaction(
  params: PrepareSwapParams,
): Promise<{ tx: VersionedTransaction; meta: PreparedSwapMeta; outAmount?: string }> {
  const prepared = await prepareSwapTransaction(params);
  const tx = VersionedTransaction.deserialize(
    Buffer.from(prepared.swapTransaction, "base64"),
  );
  return { tx, meta: prepared, outAmount: prepared.outAmount };
}

export type SignOneTransaction = (
  tx: VersionedTransaction,
) => Promise<VersionedTransaction>;

/** Batch sign with one-by-one fallback when wallet rejects the batch. */
export async function signTransactionsWithFallback(
  transactions: VersionedTransaction[],
  signAllTransactions: (
    txs: VersionedTransaction[],
  ) => Promise<VersionedTransaction[]>,
  signTransaction?: SignOneTransaction,
): Promise<VersionedTransaction[]> {
  if (transactions.length === 0) return [];

  try {
    return await signAllTransactions(transactions);
  } catch (batchError) {
    if (!signTransaction) throw batchError;
    console.warn(
      "Batch sign rejected, falling back to one-by-one:",
      batchError,
    );
  }

  const signed: VersionedTransaction[] = [];
  for (const tx of transactions) {
    signed.push(await signTransaction(tx));
  }
  return signed;
}

export type ExecuteClientSwapParams = PrepareSwapParams & {
  connection: Connection;
  signTransaction: SignOneTransaction;
  /** Skip Raptor poll when submit fell back to RPC (confirm via connection). */
  pollRaptor?: boolean;
};

export type ExecuteClientSwapResult = {
  signature: string;
  via: SwapSendVia;
  outAmount?: string;
};

/** Single client-side swap: Raptor prepare → sign → submit → confirm. */
export async function executeClientSwap(
  params: ExecuteClientSwapParams,
): Promise<ExecuteClientSwapResult> {
  const prepared = await prepareSwapTransaction(params);
  const tx = VersionedTransaction.deserialize(
    Buffer.from(prepared.swapTransaction, "base64"),
  );
  const signedTx = await params.signTransaction(tx);
  const sendResult = await submitSignedSwap({
    signedTx,
    prepared,
    connection: params.connection,
    direct: params.direct,
  });

  if (params.pollRaptor !== false) {
    await confirmSwapSignature({
      signature: sendResult.signature,
      via: sendResult.via,
      checkViaRaptor: sendResult.checkViaRaptor,
      connection: params.connection,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      blockhash: signedTx.message.recentBlockhash,
      direct: params.direct,
    });
  }

  return {
    signature: sendResult.signature,
    via: sendResult.via,
    outAmount: prepared.outAmount,
  };
}
