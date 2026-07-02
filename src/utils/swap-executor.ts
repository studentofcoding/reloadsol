import {
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  fetchUltraOrder,
  fetchUltraExecute,
  fetchUltraOrderDirect,
  fetchUltraExecuteDirect,
  parseUltraOrderTransaction,
  parseUltraOutAmount,
  JupiterUltraError,
} from "@/utils/jupiter-ultra";
import {
  fetchRaptorQuoteAndSwap,
  fetchRaptorQuoteAndSwapDirect,
  fetchRaptorQuote,
  fetchRaptorQuoteDirect,
  sendRaptorTransaction,
  sendRaptorTransactionDirect,
  type RaptorQuoteAndSwapParams,
  type RaptorQuoteResponse,
} from "@/utils/solanatracker-raptor";
import { injectInstructionsIntoVersionedTransaction } from "@/utils/jupiter-reclaim";
import type { SwapQuote, SwapTransaction } from "@/types";

export type SwapProvider = "ultra" | "raptor";

export type PreparedSwap = {
  provider: SwapProvider;
  swapTransaction: string;
  requestId?: string;
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
  /** Server-side routes set true to call Ultra/Raptor directly */
  direct?: boolean;
  /** Optional fee instructions injected into Ultra-built txs */
  feeInstructions?: TransactionInstruction[];
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

async function prepareUltraSwap(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  const orderParams = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    taker: params.userPublicKey,
    swapMode: "ExactIn" as const,
    slippageBps: params.slippageBps,
  };

  const useDirect = params.direct ?? typeof window === "undefined";
  const orderResponse = useDirect
    ? await fetchUltraOrderDirect(orderParams)
    : await fetchUltraOrder(orderParams);

  const { transaction, requestId } = parseUltraOrderTransaction(orderResponse);

  let swapTransaction = transaction;
  if (
    params.feeInstructions &&
    params.feeInstructions.length > 0 &&
    params.connection
  ) {
    const tx = await injectInstructionsIntoVersionedTransaction(
      params.connection,
      transaction,
      params.feeInstructions,
      new PublicKey(params.userPublicKey),
    );
    swapTransaction = Buffer.from(tx.serialize()).toString("base64");
  }

  return {
    provider: "ultra",
    swapTransaction,
    requestId,
    outAmount: parseUltraOutAmount(orderResponse),
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
    throw new JupiterUltraError("Raptor returned no swapTransaction");
  }

  return {
    provider: "raptor",
    swapTransaction: swapResult.swapTransaction,
    outAmount: swapResult.quote.amountOut,
    lastValidBlockHeight: swapResult.lastValidBlockHeight,
  };
}

/** Ultra first, Raptor fallback — builds unsigned swap transaction. */
export async function prepareSwapTransaction(
  params: PrepareSwapParams,
): Promise<PreparedSwap> {
  try {
    return await prepareUltraSwap(params);
  } catch (ultraError) {
    console.warn("Ultra swap order failed, falling back to Raptor:", ultraError);
    return prepareRaptorSwap(params);
  }
}

/** Quote for UI — Raptor GET /quote (no lite-api). */
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

/** Build swap tx — Ultra first, Raptor fallback. */
export async function buildSwapTransaction(
  quote: SwapQuote,
  userPublicKey: string,
  priorityFeeLamports = 0,
  options?: {
    direct?: boolean;
    feeAccount?: string;
    feeBps?: number;
    feeInstructions?: TransactionInstruction[];
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
      feeInstructions: options?.feeInstructions,
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

/** Submit signed swap — Ultra execute or Raptor send / RPC fallback. */
export async function submitSignedSwap(
  params: SubmitSignedSwapParams,
): Promise<{ signature: string; via: SwapProvider | "rpc" }> {
  const signedBase64 = Buffer.from(params.signedTx.serialize()).toString("base64");

  if (params.prepared.provider === "ultra" && params.prepared.requestId) {
    const useDirect = params.direct ?? typeof window === "undefined";
    const executeResult = useDirect
      ? await fetchUltraExecuteDirect({
          signedTransaction: signedBase64,
          requestId: params.prepared.requestId,
        })
      : await fetchUltraExecute({
          signedTransaction: signedBase64,
          requestId: params.prepared.requestId,
        });

    const signature =
      typeof executeResult.signature === "string"
        ? executeResult.signature
        : undefined;

    if (!signature) {
      throw new JupiterUltraError("Ultra execute returned no signature");
    }

    return { signature, via: "ultra" };
  }

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

  const signature = await params.connection.sendTransaction(params.signedTx, {
    skipPreflight: true,
    maxRetries: 2,
  });
  return { signature, via: "rpc" };
}

/** Metadata for bulk flows: attach provider + requestId per signed tx index. */
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
