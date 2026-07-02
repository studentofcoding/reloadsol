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

  const signature = await params.connection.sendTransaction(params.signedTx, {
    skipPreflight: true,
    maxRetries: 2,
  });
  return { signature, via: "rpc" };
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

  if (sendResult.via === "raptor" && params.pollRaptor !== false) {
    await waitForRaptorConfirmation(sendResult.signature, {
      direct: params.direct,
    });
  } else if (sendResult.via === "rpc") {
    await params.connection.confirmTransaction(sendResult.signature, "confirmed");
  }

  return {
    signature: sendResult.signature,
    via: sendResult.via,
    outAmount: prepared.outAmount,
  };
}
