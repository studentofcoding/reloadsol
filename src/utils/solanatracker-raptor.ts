import { TOKENS } from "@/utils/solana";

export const RAPTOR_DEFAULT_BASE = "https://raptor-beta.solanatracker.io";
export const RAPTOR_FETCH_TIMEOUT_MS = 20_000;
export const RAPTOR_DEV_FEE_BPS = 50;
export const RAPTOR_DEV_FEE_ACCOUNT =
  "3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX";

/** Direct/single-hop only — avoids multi-hop route failures on thin pump tokens. */
export const RAPTOR_DEFAULT_MAX_HOPS = 1;

/** Arb-only default — never applied to directional bots. */
export const RAPTOR_DEFAULT_MAX_HOPS_ARBITRAGE = 3;

export function getRaptorMaxHops(): number {
  const raw = process.env.RAPTOR_MAX_HOPS?.trim();
  if (!raw) return RAPTOR_DEFAULT_MAX_HOPS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : RAPTOR_DEFAULT_MAX_HOPS;
}

/** maxHops for SOL arbitration paths only (`RAPTOR_MAX_HOPS_ARBITRAGE`). */
export function getRaptorMaxHopsArbitrage(): number {
  const raw = process.env.RAPTOR_MAX_HOPS_ARBITRAGE?.trim();
  if (!raw) return RAPTOR_DEFAULT_MAX_HOPS_ARBITRAGE;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : RAPTOR_DEFAULT_MAX_HOPS_ARBITRAGE;
}

export class RaptorAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "RaptorAPIError";
  }
}

export type RaptorQuoteResponse = {
  inputMint: string;
  outputMint: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  feeAmount?: string;
  priceImpact: number;
  slippageBps: number;
  routePlan?: unknown[];
  contextSlot?: number;
  timeTaken?: number;
};

export type RaptorQuoteAndSwapResponse = {
  quote: RaptorQuoteResponse;
  swapTransaction: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
};

export type RaptorSendResponse = {
  success: boolean;
  signature: string;
};

export type RaptorTxStatus = {
  status: "pending" | "confirmed" | "failed" | "expired";
  latency_ms?: number;
  slot?: number;
};

export type RaptorQuoteDisplay = {
  inputMint: string;
  outputMint: string;
  amount: string;
  outAmount: string;
  minAmountOut: string;
  priceImpact: number;
  slippageBps: number;
  route: RaptorQuoteResponse;
};

export function getRaptorBaseUrl(): string {
  return process.env.RAPTOR_API_BASE ?? RAPTOR_DEFAULT_BASE;
}

export function mapRaptorQuoteToDisplay(
  quote: RaptorQuoteResponse,
  amountRaw: string,
): RaptorQuoteDisplay {
  return {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    amount: amountRaw,
    outAmount: quote.amountOut,
    minAmountOut: quote.minAmountOut,
    priceImpact: quote.priceImpact ?? 0,
    slippageBps: quote.slippageBps,
    route: quote,
  };
}

export function getRaptorPriorityFeeParams(priorityFeeLamports: number): {
  priorityFee: string;
  maxPriorityFee: number;
} {
  if (priorityFeeLamports >= 150_000) {
    return { priorityFee: "veryHigh", maxPriorityFee: priorityFeeLamports };
  }
  if (priorityFeeLamports >= 30_000) {
    return { priorityFee: "high", maxPriorityFee: priorityFeeLamports };
  }
  if (priorityFeeLamports > 0) {
    return { priorityFee: "medium", maxPriorityFee: priorityFeeLamports };
  }
  return { priorityFee: "medium", maxPriorityFee: 1_000_000 };
}

export type RaptorQuoteAndSwapParams = {
  userPublicKey: string;
  inputMint: string;
  outputMint: string;
  amount: string | number;
  slippageBps: number;
  priorityFeeLamports?: number;
  feeAccount?: string;
  feeBps?: number;
  /** Override global hops (arb uses getRaptorMaxHopsArbitrage). */
  maxHops?: number;
};

export function buildRaptorQuoteAndSwapBody(
  params: RaptorQuoteAndSwapParams,
): Record<string, unknown> {
  const priority = getRaptorPriorityFeeParams(params.priorityFeeLamports ?? 0);
  return {
    userPublicKey: params.userPublicKey,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: params.slippageBps,
    wrapUnwrapSol: true,
    txVersion: "V0",
    maxHops: params.maxHops ?? getRaptorMaxHops(),
    priorityFee: priority.priorityFee,
    maxPriorityFee: priority.maxPriorityFee,
    feeAccount: params.feeAccount ?? RAPTOR_DEV_FEE_ACCOUNT,
    feeBps: params.feeBps ?? RAPTOR_DEV_FEE_BPS,
  };
}

async function raptorFetch<T>(
  path: string,
  init?: RequestInit,
  options?: { baseUrl?: string; timeoutMs?: number },
): Promise<T> {
  const baseUrl = options?.baseUrl ?? getRaptorBaseUrl();
  const timeoutMs = options?.timeoutMs ?? RAPTOR_FETCH_TIMEOUT_MS;
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const bodyText = await response.text().catch(() => "");
    let data: T;
    try {
      data = JSON.parse(bodyText) as T;
    } catch {
      throw new RaptorAPIError(
        `Raptor invalid JSON (${response.status}): ${bodyText.slice(0, 200)}`,
        response.status,
      );
    }

    if (!response.ok) {
      const message =
        (data as { error?: string; message?: string }).error ??
        (data as { message?: string }).message ??
        bodyText.slice(0, 200);
      throw new RaptorAPIError(
        `Raptor API failed (${response.status}): ${message}`,
        response.status,
      );
    }

    return data;
  } catch (error) {
    if (error instanceof RaptorAPIError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new RaptorAPIError(`Raptor API timed out after ${timeoutMs}ms`, 504);
    }
    throw new RaptorAPIError(
      error instanceof Error ? error.message : "Unknown Raptor API error",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Server-side: GET /quote */
export async function fetchRaptorQuoteDirect(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  maxHops?: number,
): Promise<RaptorQuoteResponse> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
    maxHops: String(maxHops ?? getRaptorMaxHops()),
  });
  return raptorFetch<RaptorQuoteResponse>(`/quote?${params.toString()}`);
}

/** Server-side: POST /quote-and-swap */
export async function fetchRaptorQuoteAndSwapDirect(
  params: RaptorQuoteAndSwapParams,
): Promise<RaptorQuoteAndSwapResponse> {
  return raptorFetch<RaptorQuoteAndSwapResponse>("/quote-and-swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRaptorQuoteAndSwapBody(params)),
  });
}

/** Server-side: POST /send-transaction */
export async function sendRaptorTransactionDirect(
  signedBase64: string,
): Promise<RaptorSendResponse> {
  return raptorFetch<RaptorSendResponse>("/send-transaction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedBase64 }),
  });
}

/** Server-side: GET /transaction/:signature */
export async function getRaptorTransactionStatusDirect(
  signature: string,
): Promise<RaptorTxStatus> {
  return raptorFetch<RaptorTxStatus>(`/transaction/${encodeURIComponent(signature)}`);
}

/** Status fetch that returns null when Raptor is not tracking this sig (404/503). */
export async function getRaptorTransactionStatusSafe(
  signature: string,
  options?: { direct?: boolean },
): Promise<RaptorTxStatus | null> {
  const useDirect = options?.direct ?? typeof window === "undefined";
  try {
    return useDirect
      ? await getRaptorTransactionStatusDirect(signature)
      : await fetchRaptorTransactionStatusClient(signature);
  } catch (error) {
    if (error instanceof RaptorAPIError) {
      const code = error.statusCode;
      if (code === 404 || code === 503) return null;
    }
    throw error;
  }
}

/** Client-side via Next.js proxy */
export async function fetchRaptorQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number,
  maxHops?: number,
): Promise<RaptorQuoteResponse> {
  const query = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
    maxHops: String(maxHops ?? getRaptorMaxHops()),
  });
  const response = await fetch(`/api/solanatracker/quote?${query.toString()}`);
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new RaptorAPIError(
      err.error ?? `Quote failed (${response.status})`,
      response.status,
    );
  }
  return response.json();
}

export async function fetchRaptorQuoteAndSwap(
  params: RaptorQuoteAndSwapParams,
): Promise<RaptorQuoteAndSwapResponse> {
  const response = await fetch("/api/solanatracker/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new RaptorAPIError(
      err.error ?? `Swap build failed (${response.status})`,
      response.status,
    );
  }
  return response.json();
}

export async function sendRaptorTransaction(
  signedBase64: string,
): Promise<RaptorSendResponse> {
  const response = await fetch("/api/solanatracker/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedBase64 }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new RaptorAPIError(
      err.error ?? `Send failed (${response.status})`,
      response.status,
    );
  }
  return response.json();
}

export async function pollRaptorTransaction(
  signature: string,
  options?: {
    maxAttempts?: number;
    intervalMs?: number;
    direct?: boolean;
  },
): Promise<RaptorTxStatus> {
  const maxAttempts = options?.maxAttempts ?? 30;
  const intervalMs = options?.intervalMs ?? 2000;
  const useDirect = options?.direct ?? typeof window === "undefined";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = useDirect
      ? await getRaptorTransactionStatusDirect(signature)
      : await fetchRaptorTransactionStatusClient(signature);

    if (
      status.status === "confirmed" ||
      status.status === "failed" ||
      status.status === "expired"
    ) {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new RaptorAPIError(
    `Raptor transaction ${signature} still pending after ${maxAttempts} attempts`,
    504,
  );
}

async function fetchRaptorTransactionStatusClient(
  signature: string,
): Promise<RaptorTxStatus> {
  const response = await fetch(
    `/api/solanatracker/transaction/${encodeURIComponent(signature)}`,
  );
  if (!response.ok) {
    throw new RaptorAPIError(
      `Transaction status failed (${response.status})`,
      response.status,
    );
  }
  return response.json() as Promise<RaptorTxStatus>;
}

/** Poll until confirmed; throws on failed, expired, or timeout. */
export async function waitForRaptorConfirmation(
  signature: string,
  options?: {
    maxAttempts?: number;
    intervalMs?: number;
    direct?: boolean;
  },
): Promise<RaptorTxStatus> {
  const status = await pollRaptorTransaction(signature, options);
  if (status.status !== "confirmed") {
    throw new RaptorAPIError(`Raptor transaction ${status.status}`, 400);
  }
  return status;
}

export async function checkRaptorHealth(): Promise<{
  healthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    await fetchRaptorQuoteDirect(
      TOKENS.SOL,
      TOKENS.USDC,
      "1000000",
      200,
    );
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
