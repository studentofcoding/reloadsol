import type { SwapQuote } from "@/types";

export const JUPITER_LITE_SWAP_BASE = "https://lite-api.jup.ag/swap/v1";
export const JUPITER_LITE_FETCH_TIMEOUT_MS = 20_000;

export class JupiterLiteError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "JupiterLiteError";
  }
}

export type JupiterLiteQuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan?: unknown[];
  [key: string]: unknown;
};

export type JupiterLiteSwapResponse = {
  swapTransaction: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
  [key: string]: unknown;
};

function getClientBaseUrl(): string {
  if (typeof window !== "undefined") return "";
  return (
    process.env.API_HOST ||
    process.env.NEXT_PUBLIC_API_HOST ||
    "http://localhost:3000"
  );
}

async function liteFetch<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = JUPITER_LITE_FETCH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const isClient = typeof window !== "undefined";
    const url = isClient
      ? `${getClientBaseUrl()}/api/jupiter/lite${path}`
      : `${JUPITER_LITE_SWAP_BASE}${path}`;

    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const bodyText = await response.text().catch(() => "");

    if (!response.ok) {
      throw new JupiterLiteError(
        `Jupiter Lite failed (${response.status}): ${bodyText.slice(0, 200)}`,
        response.status,
      );
    }

    try {
      return JSON.parse(bodyText) as T;
    } catch {
      throw new JupiterLiteError(
        `Jupiter Lite returned invalid JSON: ${bodyText.slice(0, 200)}`,
        response.status,
      );
    }
  } catch (error) {
    if (error instanceof JupiterLiteError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new JupiterLiteError(
        `Jupiter Lite timed out after ${timeoutMs}ms`,
        504,
      );
    }
    throw new JupiterLiteError(
      error instanceof Error ? error.message : "Unknown Jupiter Lite error",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function mapJupiterLiteQuoteToSwapQuote(
  quote: JupiterLiteQuoteResponse,
): SwapQuote {
  return {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    swapMode: quote.swapMode === "ExactOut" ? "ExactOut" : "ExactIn",
    slippageBps: quote.slippageBps,
    priceImpactPct: quote.priceImpactPct ?? "0",
    routePlan: (quote.routePlan as unknown[]) ?? [],
  };
}

/** Server-side: GET /quote */
export async function fetchJupiterLiteQuoteDirect(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
): Promise<JupiterLiteQuoteResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
  });
  return liteFetch<JupiterLiteQuoteResponse>(`/quote?${params.toString()}`);
}

/** Client-side: proxied GET /quote */
export async function fetchJupiterLiteQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
): Promise<JupiterLiteQuoteResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
  });
  return liteFetch<JupiterLiteQuoteResponse>(`/quote?${params.toString()}`);
}

export type JupiterLiteSwapParams = {
  quoteResponse: JupiterLiteQuoteResponse;
  userPublicKey: string;
  priorityFeeLamports?: number;
};

/** Server-side: POST /swap */
export async function fetchJupiterLiteSwapDirect(
  params: JupiterLiteSwapParams,
): Promise<JupiterLiteSwapResponse> {
  return liteFetch<JupiterLiteSwapResponse>("/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: params.quoteResponse,
      userPublicKey: params.userPublicKey,
      dynamicComputeUnitLimit: true,
      ...(params.priorityFeeLamports && params.priorityFeeLamports > 0
        ? {
            prioritizationFeeLamports: params.priorityFeeLamports,
          }
        : {}),
    }),
  });
}

/** Client-side: proxied POST /swap */
export async function fetchJupiterLiteSwap(
  params: JupiterLiteSwapParams,
): Promise<JupiterLiteSwapResponse> {
  return fetchJupiterLiteSwapDirect(params);
}

export type JupiterLitePreparedSwap = {
  swapTransaction: string;
  outAmount: string;
  lastValidBlockHeight?: number;
  quoteResponse: JupiterLiteQuoteResponse;
};

/** Two-step quote + swap build (Jupiter Lite). */
export async function prepareJupiterLiteSwap(
  params: {
    userPublicKey: string;
    inputMint: string;
    outputMint: string;
    amount: string | number;
    slippageBps: number;
    priorityFeeLamports?: number;
    direct?: boolean;
  },
): Promise<JupiterLitePreparedSwap> {
  const amountStr = String(params.amount);
  const useDirect = params.direct ?? typeof window === "undefined";

  const quote = useDirect
    ? await fetchJupiterLiteQuoteDirect(
        params.inputMint,
        params.outputMint,
        amountStr,
        params.slippageBps,
      )
    : await fetchJupiterLiteQuote(
        params.inputMint,
        params.outputMint,
        amountStr,
        params.slippageBps,
      );

  const swap = useDirect
    ? await fetchJupiterLiteSwapDirect({
        quoteResponse: quote,
        userPublicKey: params.userPublicKey,
        priorityFeeLamports: params.priorityFeeLamports,
      })
    : await fetchJupiterLiteSwap({
        quoteResponse: quote,
        userPublicKey: params.userPublicKey,
        priorityFeeLamports: params.priorityFeeLamports,
      });

  if (!swap.swapTransaction) {
    throw new JupiterLiteError("Jupiter Lite returned no swapTransaction");
  }

  return {
    swapTransaction: swap.swapTransaction,
    outAmount: quote.outAmount,
    lastValidBlockHeight: swap.lastValidBlockHeight,
    quoteResponse: quote,
  };
}
