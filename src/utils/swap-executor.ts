import { Connection, VersionedTransaction } from "@solana/web3.js";
import {
  fetchRaptorQuoteAndSwap,
  fetchRaptorQuoteAndSwapDirect,
  fetchRaptorQuote,
  fetchRaptorQuoteDirect,
  sendRaptorTransaction,
  sendRaptorTransactionDirect,
  waitForRaptorConfirmation,
  RaptorAPIError,
  type RaptorQuoteAndSwapParams,
  type RaptorQuoteResponse,
} from "@/utils/solanatracker-raptor";
import { waitForRpcRateLimit } from "@/utils/rpc-rate-limit";
import type { SwapQuote, SwapTransaction } from "@/types";

export type SwapProvider = "raptor";

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

/** Raptor quote-and-swap — builds unsigned swap transaction. */
export async function prepareSwapTransaction(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  return prepareRaptorSwap(params);
}

/** Quote for UI — Raptor GET /quote. */
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

/** Submit signed swap — Raptor send with RPC fallback. */
export async function submitSignedSwap(
  params: SubmitSignedSwapParams,
): Promise<{ signature: string; via: SwapProvider | "rpc" }> {
  const signedBase64 = Buffer.from(params.signedTx.serialize()).toString("base64");

  try {
    const useDirect = params.direct ?? typeof window === "undefined";
    const sendResult = useDirect
      ? await sendRaptorTransactionDirect(signedBase64)
      : await sendRaptorTransaction(signedBase64);

    if (sendResult.success && sendResult.signature) {
      return { signature: sendResult.signature, via: "raptor" };
    }
  } catch (raptorError) {
    console.warn("Raptor send failed, falling back to RPC:", raptorError);
  }

  await waitForRpcRateLimit();
  const signature = await params.connection.sendTransaction(params.signedTx, {
    skipPreflight: true,
    maxRetries: 2,
  });
  return { signature, via: "rpc" };
}

const SIGNATURE_CONFIRM_INTERVAL_MS = 2000;
const SIGNATURE_CONFIRM_TIMEOUT_MS = 60_000;
const BATCH_CONFIRM_TIMEOUT_MS = 90_000;
const BATCH_STATUS_CHUNK = 50;
const RAPTOR_CONFIRM_CONCURRENCY = 4;

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

async function pollSignatureConfirmed(
  connection: Connection,
  signature: string,
  timeoutMs = SIGNATURE_CONFIRM_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await waitForRpcRateLimit();
    const response = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = response.value[0];

    if (status?.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }

    const confirmation = status?.confirmationStatus;
    if (confirmation === "confirmed" || confirmation === "finalized") {
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, SIGNATURE_CONFIRM_INTERVAL_MS),
    );
  }

  throw new Error(`Transaction confirmation timeout for ${signature}`);
}

export type ConfirmSwapSignatureParams = {
  signature: string;
  via: SwapProvider | "rpc";
  connection: Connection;
  lastValidBlockHeight?: number;
  blockhash?: string;
  direct?: boolean;
};

/** Raptor poll first, then RPC signature-status fallback. */
export async function confirmSwapSignature(
  params: ConfirmSwapSignatureParams,
): Promise<void> {
  if (params.via === "raptor") {
    try {
      await waitForRaptorConfirmation(params.signature, {
        direct: params.direct,
        maxAttempts: 45,
        intervalMs: 2000,
      });
      return;
    } catch (raptorError) {
      console.warn(
        "Raptor confirm failed, falling back to RPC signature check:",
        raptorError,
      );
    }
  }

  if (
    params.via === "rpc" &&
    params.blockhash &&
    params.lastValidBlockHeight != null
  ) {
    try {
      await waitForRpcRateLimit();
      const confirmation = await params.connection.confirmTransaction(
        {
          signature: params.signature,
          blockhash: params.blockhash,
          lastValidBlockHeight: params.lastValidBlockHeight,
        },
        "confirmed",
      );
      if (confirmation.value.err) {
        throw new Error(
          `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
        );
      }
      return;
    } catch (confirmError) {
      console.warn(
        "Blockhash confirm failed, falling back to signature poll:",
        confirmError,
      );
    }
  }

  await pollSignatureConfirmed(params.connection, params.signature);
}

export type BatchConfirmItem = Omit<ConfirmSwapSignatureParams, "connection">;

/** Batch confirm — Raptor per-sig (concurrency 4), then one RPC poll for all pending. */
export async function confirmSwapSignaturesBatch(
  items: BatchConfirmItem[],
  connection: Connection,
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  if (items.length === 0) return results;

  const pendingRpc = new Map<string, BatchConfirmItem>();

  const raptorItems = items.filter((item) => item.via === "raptor");
  await runWithConcurrency(
    raptorItems,
    RAPTOR_CONFIRM_CONCURRENCY,
    async (item) => {
      try {
        await waitForRaptorConfirmation(item.signature, {
          direct: item.direct,
          maxAttempts: 45,
          intervalMs: 2000,
        });
        results.set(item.signature, null);
      } catch (raptorError) {
        console.warn(
          `Raptor batch confirm failed for ${item.signature}, will RPC poll:`,
          raptorError,
        );
        pendingRpc.set(item.signature, item);
      }
    },
  );

  for (const item of items) {
    if (item.via === "rpc") {
      pendingRpc.set(item.signature, item);
    }
  }
  for (const sig of Array.from(results.keys())) {
    pendingRpc.delete(sig);
  }

  for (const [sig, item] of Array.from(pendingRpc.entries())) {
    if (item.blockhash && item.lastValidBlockHeight != null) {
      try {
        await waitForRpcRateLimit();
        const confirmation = await connection.confirmTransaction(
          {
            signature: item.signature,
            blockhash: item.blockhash,
            lastValidBlockHeight: item.lastValidBlockHeight,
          },
          "confirmed",
        );
        if (confirmation.value.err) {
          throw new Error(
            `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
          );
        }
        results.set(sig, null);
        pendingRpc.delete(sig);
      } catch {
        // ponytail: fall through to batched signature poll
      }
    }
  }

  const deadline = Date.now() + BATCH_CONFIRM_TIMEOUT_MS;
  while (pendingRpc.size > 0 && Date.now() < deadline) {
    const signatures = Array.from(pendingRpc.keys());
    for (let i = 0; i < signatures.length; i += BATCH_STATUS_CHUNK) {
      const chunk = signatures.slice(i, i + BATCH_STATUS_CHUNK);
      await waitForRpcRateLimit();
      const response = await connection.getSignatureStatuses(chunk, {
        searchTransactionHistory: true,
      });

      chunk.forEach((sig, idx) => {
        const status = response.value[idx];
        if (status?.err) {
          results.set(
            sig,
            `Transaction failed on-chain: ${JSON.stringify(status.err)}`,
          );
          pendingRpc.delete(sig);
          return;
        }
        const confirmation = status?.confirmationStatus;
        if (confirmation === "confirmed" || confirmation === "finalized") {
          results.set(sig, null);
          pendingRpc.delete(sig);
        }
      });
    }

    if (pendingRpc.size > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, SIGNATURE_CONFIRM_INTERVAL_MS),
      );
    }
  }

  for (const sig of Array.from(pendingRpc.keys())) {
    results.set(sig, `Transaction confirmation timeout for ${sig}`);
  }

  return results;
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
  via: SwapProvider | "rpc";
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
      connection: params.connection,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      direct: params.direct,
    });
  }

  return {
    signature: sendResult.signature,
    via: sendResult.via,
    outAmount: prepared.outAmount,
  };
}
