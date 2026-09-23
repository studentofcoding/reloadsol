import { Connection, VersionedTransaction } from "@solana/web3.js";
import {
  fetchRaptorQuoteAndSwap,
  fetchRaptorQuoteAndSwapDirect,
  getRaptorTransactionStatusSafe,
  RaptorAPIError,
  type RaptorQuoteAndSwapParams,
} from "@/utils/solanatracker-raptor";
import {
  resolveBuybulkFeeBps,
  resolveBuybulkSolFeeAccount,
} from "@/utils/buybulk-fee";
import { prepareJupiterLiteSwap } from "@/utils/jupiter-lite-swap";
import {
  executeJupiterSwap,
  executeJupiterSwapDirect,
  prepareJupiterSwapOrder,
} from "@/utils/jupiter-swap-quote";
import {
  getSwapQuoteMaxImpactPct,
  impactToAbsPct,
  passesImpactGate,
  type SwapQuoteProvider,
} from "@/utils/swap-quote-pick";
import {
  prefetchSlippageBps,
  resolveTradeSlippageBps,
} from "@/utils/auto-slippage";
import { pickParallelSwapQuote } from "@/utils/swap-quote-parallel";
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
import { isWalletUserRejection } from "@/utils/wallet-rejection";
import {
  resolveSolSignerMode,
  serverLandSwaps,
  signPreparedSwapTransactions,
} from "@/utils/sol-desk-signer";
import { beginTradeInFlight } from "@/utils/trade-inflight";
import {
  priorityFeeCacheToken,
  type JupiterPrioritizationFeeLamports,
} from "@/utils/priority-fee";
import type { SwapQuote, SwapTransaction } from "@/types";

export type SwapProvider = SwapQuoteProvider;

export type SwapSendVia = "raptor" | "shyft" | "rpc" | "jupiter";

export type PreparedSwap = {
  provider: SwapProvider;
  swapTransaction: string;
  outAmount?: string;
  lastValidBlockHeight?: number;
  /** Jupiter Swap V2 `/order` requestId. Present → prefer `POST /swap/v2/execute`. */
  requestId?: string;
  /** Raw order impact (fraction or percent). */
  priceImpact?: number;
};

export type PrepareSwapParams = {
  userPublicKey: string;
  inputMint: string;
  outputMint: string;
  amount: string | number;
  slippageBps: number;
  priorityFeeLamports?: JupiterPrioritizationFeeLamports;
  feeAccount?: string;
  feeBps?: number;
  /** Server-side routes set true to call Raptor directly */
  direct?: boolean;
  connection?: Connection;
  /** Arb-only: override Raptor maxHops for this prepare. */
  maxHops?: number;
};

/** Quote-and-swap txs go stale quickly; prefetch is only reused within this window. */
export const SWAP_PREPARE_TTL_MS = 8_000;

function swapPrepareCacheKey(params: PrepareSwapParams): string {
  return [
    params.userPublicKey,
    params.inputMint,
    params.outputMint,
    String(params.amount),
    params.slippageBps,
    priorityFeeCacheToken(params.priorityFeeLamports),
    params.feeAccount ?? "",
    params.feeBps ?? 0,
  ].join("|");
}

const preparedSwapCache = new Map<
  string,
  { at: number; prepared: PreparedSwap }
>();

export function putPreparedSwapCache(
  params: PrepareSwapParams,
  prepared: PreparedSwap,
  now = Date.now(),
): void {
  preparedSwapCache.set(swapPrepareCacheKey(params), { at: now, prepared });
}

export function peekFreshPreparedSwap(
  params: PrepareSwapParams,
  now = Date.now(),
): PreparedSwap | null {
  const e = preparedSwapCache.get(swapPrepareCacheKey(params));
  if (!e || now - e.at > SWAP_PREPARE_TTL_MS) return null;
  return e.prepared;
}

/** Consume a still-fresh prefetch so the click path does not rebuild. */
export function takeFreshPreparedSwap(
  params: PrepareSwapParams,
  now = Date.now(),
): PreparedSwap | null {
  const key = swapPrepareCacheKey(params);
  const e = preparedSwapCache.get(key);
  if (!e || now - e.at > SWAP_PREPARE_TTL_MS) {
    preparedSwapCache.delete(key);
    return null;
  }
  preparedSwapCache.delete(key);
  return e.prepared;
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
    feeAccount: resolveBuybulkSolFeeAccount(params.feeAccount),
    feeBps: resolveBuybulkFeeBps(params.feeBps),
    maxHops: params.maxHops,
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
    priceImpact: swapResult.quote.priceImpact,
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

  const liteImpact = Number(lite.quoteResponse.priceImpactPct);
  return {
    provider: "jupiter_lite",
    swapTransaction: lite.swapTransaction,
    outAmount: lite.outAmount,
    lastValidBlockHeight: lite.lastValidBlockHeight,
    priceImpact: Number.isFinite(liteImpact) ? liteImpact : undefined,
  };
}

class SwapImpactGateError extends Error {
  constructor(maxImpactPct: number) {
    super(`No swap route within ${maxImpactPct}% price impact`);
    this.name = "SwapImpactGateError";
  }
}

function assertSwapImpact(rawImpact: unknown): void {
  const maxImpactPct = getSwapQuoteMaxImpactPct();
  if (!passesImpactGate(impactToAbsPct(rawImpact), maxImpactPct)) {
    throw new SwapImpactGateError(maxImpactPct);
  }
}

async function prepareJupiterSwapPrepared(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  const order = await prepareJupiterSwapOrder({
    userPublicKey: params.userPublicKey,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: params.slippageBps,
    priorityFeeLamports: params.priorityFeeLamports,
    direct: params.direct,
  });
  assertSwapImpact(order.priceImpact);

  return {
    provider: "jupiter_swap",
    swapTransaction: order.swapTransaction,
    outAmount: order.outAmount,
    lastValidBlockHeight: order.lastValidBlockHeight,
    requestId: order.requestId,
    priceImpact: order.priceImpact,
  };
}

/** Desk (no maxHops): one V2 `/order` with taker. Lite only if that order fails. */
async function prepareDeskSwap(params: PrepareSwapParams): Promise<PreparedSwap> {
  try {
    return await prepareJupiterSwapPrepared(params);
  } catch (error) {
    if (error instanceof SwapImpactGateError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[swap] Jupiter V2 /order failed, falling back to Lite:", message);
  }

  const lite = await prepareJupiterLiteSwap({
    userPublicKey: params.userPublicKey,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: params.slippageBps,
    priorityFeeLamports: params.priorityFeeLamports,
    direct: params.direct,
  });
  assertSwapImpact(lite.quoteResponse.priceImpactPct);
  const liteImpact = Number(lite.quoteResponse.priceImpactPct);
  return {
    provider: "jupiter_lite",
    swapTransaction: lite.swapTransaction,
    outAmount: lite.outAmount,
    lastValidBlockHeight: lite.lastValidBlockHeight,
    priceImpact: Number.isFinite(liteImpact) ? liteImpact : undefined,
  };
}

/** Arb (`maxHops` set): Raptor with hops override; Lite only if Raptor cannot build. */
async function prepareArbSwap(params: PrepareSwapParams): Promise<PreparedSwap> {
  if (getTradeProvider() === "shyft") {
    return prepareShyftStackSwap(params);
  }
  return prepareRaptorSwap(params);
}

/** Shyft stack arb/legacy: Raptor (buy_bulk 25 bps) first. Jupiter Lite has no
 *  referral ATA in this repo, so it cannot collect the platform fee —
 *  fallback is last-resort only when Raptor cannot build the tx. */
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

/** Quote-and-swap. Desk is Jupiter V2; arb (`maxHops`) stays on Raptor. */
export async function prepareSwapTransaction(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  // Live arb passes maxHops and must keep Raptor hops, not the desk Jupiter path.
  if (params.maxHops != null) {
    return prepareArbSwap(params);
  }
  return prepareDeskSwap(params);
}

export async function prefetchSwapTransaction(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  const prepared = await prepareSwapTransaction(params);
  putPreparedSwapCache(params, prepared);
  return prepared;
}

/**
 * Build the seed order, then a second order only when auto slippage
 * comes out tighter or wider than that seed. Click-time prepare can reuse
 * whichever of those is still inside the prefetch TTL.
 */
export async function warmResolvedPreparedSwap(
  base: Omit<PrepareSwapParams, "slippageBps">,
  selectedSlippageBps: number,
): Promise<{ slippageBps: number; impactPct: number | null }> {
  const seedBps = prefetchSlippageBps(selectedSlippageBps);
  const seedParams: PrepareSwapParams = { ...base, slippageBps: seedBps };
  const seeded =
    peekFreshPreparedSwap(seedParams) ??
    (await prefetchSwapTransaction(seedParams));
  const impactPct =
    seeded.priceImpact == null ? null : impactToAbsPct(seeded.priceImpact);
  const slippageBps = resolveTradeSlippageBps(selectedSlippageBps, impactPct);
  if (slippageBps !== seedBps) {
    const resolved: PrepareSwapParams = { ...base, slippageBps };
    if (!peekFreshPreparedSwap(resolved)) {
      await prefetchSwapTransaction(resolved);
    }
  }
  return { slippageBps, impactPct };
}

/** UI quote — Jupiter V2 `/order` without taker. Lite only if V2 fails. */
export async function fetchSwapQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
  direct?: boolean,
): Promise<SwapQuote | null> {
  try {
    if (amount <= 0) return null;
    const picked = await pickParallelSwapQuote({
      inputMint,
      outputMint,
      amount: String(amount),
      slippageBps,
      direct,
    });
    return picked?.quote ?? null;
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

/** Build swap tx via the gated winning provider. */
export async function buildSwapTransaction(
  quote: SwapQuote,
  userPublicKey: string,
  priorityFeeLamports: JupiterPrioritizationFeeLamports = 0,
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
  /** Jupiter `/execute` Success (code 0) already confirmed the landing. */
  landed?: boolean;
  outputAmount?: string;
};

function prefersJupiterExecute(prepared: PreparedSwap): boolean {
  return (
    prepared.provider === "jupiter_swap" &&
    typeof prepared.requestId === "string" &&
    prepared.requestId.length > 0
  );
}

function signedTxBase64(signedTx: VersionedTransaction): string {
  // This web3.js VersionedTransaction.serialize() keeps unsigned slots as
  // zeroed signatures, which JupiterZ needs until /execute adds the MM sig.
  return Buffer.from(signedTx.serialize()).toString("base64");
}

/** Jupiter managed landing. Returns null so the caller can use RPC/Shyft. */
async function tryJupiterExecute(
  params: SubmitSignedSwapParams,
  useDirect: boolean,
): Promise<SubmitSignedSwapResult | null> {
  const requestId = params.prepared.requestId;
  if (!prefersJupiterExecute(params.prepared) || !requestId) return null;
  try {
    const executed = useDirect
      ? await executeJupiterSwapDirect({
          signedTransaction: signedTxBase64(params.signedTx),
          requestId,
        })
      : await executeJupiterSwap({
          signedTransaction: signedTxBase64(params.signedTx),
          requestId,
        });
    return {
      signature: executed.signature,
      via: "jupiter",
      checkViaRaptor: false,
      landed: true,
      ...(executed.outputAmountResult
        ? { outputAmount: executed.outputAmountResult }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[swap] Jupiter /execute failed, falling back to RPC/Shyft:", message);
    return null;
  }
}

/** Submit signed swap. Jupiter V2 `/execute` first when `requestId` is set. */
export async function submitSignedSwap(
  params: SubmitSignedSwapParams,
): Promise<SubmitSignedSwapResult> {
  const useDirect = params.direct ?? typeof window === "undefined";

  const executed = await tryJupiterExecute(params, useDirect);
  if (executed) return executed;

  if (getTradeProvider() === "shyft") {
    const signedBase64 = signedTxBase64(params.signedTx);
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

  // Raptor stack: send via RPC only; confirm still uses Raptor status API
  // when the tx was built by Raptor (Lite/Swap txs are not in Raptor's tracker).
  await waitForRpcRateLimit();
  const signature = await params.connection.sendTransaction(params.signedTx, {
    skipPreflight: true,
    maxRetries: 2,
  });
  return {
    signature,
    via: "rpc",
    checkViaRaptor: params.prepared.provider === "raptor",
  };
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
      landed?: boolean;
      outputAmount?: string;
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
      return {
        index: item.index,
        success: true,
        signature,
        via: "rpc",
        checkViaRaptor: getTradeProvider() === "raptor",
      };
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

async function submitOneSignedSwap(
  item: SubmitSignedSwapBatchItem,
  connection: Connection,
  direct?: boolean,
): Promise<SubmitSignedSwapBatchResult> {
  try {
    const sendResult = await submitSignedSwap({
      signedTx: item.signedTx,
      prepared: item.prepared,
      connection,
      direct,
    });
    return {
      index: item.index,
      success: true,
      signature: sendResult.signature,
      via: sendResult.via,
      checkViaRaptor: sendResult.checkViaRaptor,
      landed: sendResult.landed,
      outputAmount: sendResult.outputAmount,
    };
  } catch (error) {
    return { index: item.index, success: false, error };
  }
}

/** Batch submit. Jupiter `requestId` swaps use `/execute`; the rest stay on send_many. */
export async function submitSignedSwapBatch(
  items: SubmitSignedSwapBatchItem[],
  connection: Connection,
  direct?: boolean,
): Promise<SubmitSignedSwapBatchResult[]> {
  if (items.length === 0) return [];

  const useDirect = direct ?? typeof window === "undefined";

  if (items.length === 1) {
    return [await submitOneSignedSwap(items[0], connection, direct)];
  }

  const managed = items.filter((item) => prefersJupiterExecute(item.prepared));
  const rest = items.filter((item) => !prefersJupiterExecute(item.prepared));
  const managedResults = await Promise.all(
    managed.map((item) => submitOneSignedSwap(item, connection, direct)),
  );

  let restResults: SubmitSignedSwapBatchResult[] = [];
  if (rest.length === 1) {
    restResults = [await submitOneSignedSwap(rest[0], connection, direct)];
  } else if (rest.length > 1) {
    restResults = await submitShyftManyBatch(rest, connection, useDirect);
  }

  return [...managedResults, ...restResults].sort((a, b) => a.index - b.index);
}

/**
 * A missed status check used to sleep 3000ms. That sleep alone measured
 * 3003ms, which is the click-to-success gap after Jupiter has already
 * returned Success. Fresh landings are visible well inside a second.
 */
export const CONFIRM_POLL_INTERVAL_MS = 400;
const CONFIRM_HISTORY_AFTER_MS = 8_000;
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
  const confirmStartedAt = Date.now();

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
        searchTransactionHistory:
          Date.now() - confirmStartedAt >= CONFIRM_HISTORY_AFTER_MS,
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

/** Jupiter Success rows are already confirmed. Poll only the rest. */
export async function confirmUnlandedSwaps(
  items: Array<BatchConfirmItem & { landed?: boolean }>,
  connection: Connection,
  options?: ConfirmBatchOptions,
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  const pending: BatchConfirmItem[] = [];
  for (const item of items) {
    if (item.landed) results.set(item.signature, null);
    else pending.push(item);
  }
  if (pending.length === 0) return results;
  const polled = await confirmSwapSignaturesBatch(pending, connection, options);
  for (const [signature, error] of polled) results.set(signature, error);
  return results;
}

/**
 * Server-sign + Jupiter /execute in one hop when every leg has a requestId.
 * Null means the caller should sign and submit itself. A partial land returns
 * null on purpose: resubmitting the same bytes is the same signature, and
 * Jupiter will not execute it twice.
 */
export async function tryLandPreparedOnServer(
  userPublicKey: string,
  metas: PreparedSwap[],
): Promise<SubmitSignedSwapBatchResult[] | null> {
  if (typeof window === "undefined" || metas.length === 0) return null;
  if (!metas.every((meta) => prefersJupiterExecute(meta))) return null;
  try {
    const mode = await resolveSolSignerMode(userPublicKey);
    if (mode !== "server") return null;
    const rows = await serverLandSwaps(
      metas.map((meta) => ({
        swapTransaction: meta.swapTransaction,
        requestId: meta.requestId as string,
      })),
    );
    if (rows.some((row) => !("signature" in row))) return null;
    return rows.map((row, index) => {
      const landed = row as { signature: string; outputAmount?: string };
      return {
        index,
        success: true as const,
        signature: landed.signature,
        via: "jupiter" as const,
        landed: true,
        outputAmount: landed.outputAmount,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[swap] server land unavailable:", message);
    return null;
  }
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
  const prepared =
    takeFreshPreparedSwap(params) ?? (await prepareSwapTransaction(params));
  const tx = VersionedTransaction.deserialize(
    Buffer.from(prepared.swapTransaction, "base64"),
  );
  return { tx, meta: prepared, outAmount: prepared.outAmount };
}

export type SignOneTransaction = (
  tx: VersionedTransaction,
) => Promise<VersionedTransaction>;

/** Batch sign with one-by-one fallback when wallet cannot batch-sign. */
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
    // User cancel must not fall back to token[0] one-by-one prompts.
    if (isWalletUserRejection(batchError) || !signTransaction) {
      throw batchError;
    }
    console.warn(
      "Batch sign failed, falling back to one-by-one:",
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

const WALLET_SIGN_TIMEOUT_MS = 60_000; // a stale wallet popup must not hang the swap forever

/** Bound a wallet sign (popup) so a stale/ignored request settles with an error. */
function withWalletSignTimeout<T>(
  promise: Promise<T>,
  timeoutMessage = "Timed out waiting for wallet signature — approve the transaction in your wallet and try again",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, WALLET_SIGN_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function logSwapTiming(fields: Record<string, string | number | boolean>): void {
  const parts = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  console.info(`[swap-timing] ${parts.join(" ")}`);
}

function flightError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Single client-side swap: Jupiter V2 prepare → sign → execute (or RPC/Shyft) → confirm. */
export async function executeClientSwap(
  params: ExecuteClientSwapParams,
): Promise<ExecuteClientSwapResult> {
  const flight = beginTradeInFlight();
  const started = Date.now();
  let prepareMs = 0;
  let signMs = 0;
  let submitMs = 0;
  let confirmMs = 0;
  try {
    const signerModePromise = resolveSolSignerMode(params.userPublicKey);
    const prepareStarted = Date.now();
    const prepared =
      takeFreshPreparedSwap(params) ?? (await prepareSwapTransaction(params));
    prepareMs = Date.now() - prepareStarted;
    const signerMode = await signerModePromise;

    if (signerMode === "server") {
      const landStarted = Date.now();
      const landed = await tryLandPreparedOnServer(params.userPublicKey, [
        prepared,
      ]);
      const landedRow = landed?.[0];
      if (landedRow?.success) {
        submitMs = Date.now() - landStarted;
        logSwapTiming({
          prepareMs,
          signMs: 0,
          submitMs,
          confirmMs: 0,
          totalMs: Date.now() - started,
          via: "jupiter",
          landed: true,
          server: true,
        });
        flight.succeed();
        return {
          signature: landedRow.signature,
          via: "jupiter",
          outAmount: landedRow.outputAmount ?? prepared.outAmount,
        };
      }
    }

    const tx = VersionedTransaction.deserialize(
      Buffer.from(prepared.swapTransaction, "base64"),
    );
    const signStarted = Date.now();
    const { signed } = await withWalletSignTimeout(
      signPreparedSwapTransactions({
        userPublicKey: params.userPublicKey,
        transactions: [tx],
        mode: signerMode,
        walletSign: async (txs) => {
          const next = txs[0];
          if (!next) throw new Error("Swap signing returned no transaction");
          return [await params.signTransaction(next)];
        },
      }),
      signerMode === "server"
        ? "Timed out waiting for server signature — try the trade again"
        : undefined,
    );
    signMs = Date.now() - signStarted;
    const signedTx = signed[0];
    if (!signedTx) {
      throw new Error("Swap signing returned no transaction");
    }
    const submitStarted = Date.now();
    const sendResult = await submitSignedSwap({
      signedTx,
      prepared,
      connection: params.connection,
      direct: params.direct,
    });
    submitMs = Date.now() - submitStarted;

    if (!sendResult.landed && params.pollRaptor !== false) {
      const confirmStarted = Date.now();
      await confirmSwapSignature({
        signature: sendResult.signature,
        via: sendResult.via,
        checkViaRaptor: sendResult.checkViaRaptor,
        connection: params.connection,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        blockhash: signedTx.message.recentBlockhash,
        direct: params.direct,
      });
      confirmMs = Date.now() - confirmStarted;
    }

    logSwapTiming({
      prepareMs,
      signMs,
      submitMs,
      confirmMs,
      totalMs: Date.now() - started,
      via: sendResult.via,
      landed: Boolean(sendResult.landed),
      server: signerMode === "server",
    });
    flight.succeed();
    return {
      signature: sendResult.signature,
      via: sendResult.via,
      outAmount: sendResult.outputAmount ?? prepared.outAmount,
    };
  } catch (error) {
    logSwapTiming({
      prepareMs,
      signMs,
      submitMs,
      confirmMs,
      totalMs: Date.now() - started,
      error: true,
    });
    flight.fail(flightError(error));
    throw error;
  }
}
