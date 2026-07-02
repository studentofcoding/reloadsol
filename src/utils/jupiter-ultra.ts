export const JUPITER_ULTRA_API_BASE =
  process.env.JUPITER_ULTRA_API_BASE ?? "https://ultra-api.jup.ag";
export const JUPITER_ULTRA_CLIENT_PLATFORM = "jupiter.web.home_page";
export const ULTRA_FETCH_TIMEOUT_MS = 20_000;

export class JupiterUltraError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "JupiterUltraError";
    this.statusCode = statusCode;
  }
}

export type UltraOrderParams = {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  taker: string;
  swapMode?: "ExactIn" | "ExactOut";
  slippageBps?: number;
};

export type UltraOrderResponse = {
  transaction?: string;
  swapTransaction?: string;
  requestId?: string;
  inAmount?: string;
  outAmount?: string;
  inputAmount?: string;
  outputAmount?: string;
  signature?: string;
  [key: string]: unknown;
};

export type UltraExecuteParams = {
  signedTransaction: string;
  requestId: string;
};

export type UltraExecuteResponse = {
  signature?: string;
  status?: string;
  error?: string;
  [key: string]: unknown;
};

function getClientBaseUrl(): string {
  if (typeof window !== "undefined") {
    return "";
  }
  return process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || "http://localhost:3000";
}

function extractTransactionBase64(response: UltraOrderResponse): string | null {
  if (typeof response.transaction === "string" && response.transaction.length > 0) {
    return response.transaction;
  }
  if (typeof response.swapTransaction === "string" && response.swapTransaction.length > 0) {
    return response.swapTransaction;
  }
  return null;
}

export function extractUltraRequestId(response: UltraOrderResponse): string | null {
  if (typeof response.requestId === "string" && response.requestId.length > 0) {
    return response.requestId;
  }
  return null;
}

async function ultraFetch<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = ULTRA_FETCH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${JUPITER_ULTRA_API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const payload = (await response.json().catch(() => ({}))) as T & {
      error?: string;
      message?: string;
    };

    if (!response.ok) {
      throw new JupiterUltraError(
        (payload as { error?: string; message?: string }).error ||
          (payload as { error?: string; message?: string }).message ||
          `Jupiter Ultra failed (${response.status})`,
        response.status,
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof JupiterUltraError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new JupiterUltraError(`Jupiter Ultra timed out after ${timeoutMs}ms`, 504);
    }
    throw new JupiterUltraError(
      error instanceof Error ? error.message : "Unknown Jupiter Ultra error",
    );
  } finally {
    clearTimeout(timer);
  }
}

function buildOrderQuery(params: UltraOrderParams): string {
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    taker: params.taker,
    swapMode: params.swapMode ?? "ExactIn",
    clientPlatform: JUPITER_ULTRA_CLIENT_PLATFORM,
  });
  if (params.slippageBps != null) {
    query.set("slippageBps", String(params.slippageBps));
  }
  return query.toString();
}

/** Server-side: POST /order */
export async function fetchUltraOrderDirect(
  params: UltraOrderParams,
): Promise<UltraOrderResponse> {
  return ultraFetch<UltraOrderResponse>(`/order?${buildOrderQuery(params)}`, {
    method: "POST",
  });
}

/** Server-side: POST /execute */
export async function fetchUltraExecuteDirect(
  params: UltraExecuteParams,
): Promise<UltraExecuteResponse> {
  return ultraFetch<UltraExecuteResponse>(
    `/execute?clientPlatform=${encodeURIComponent(JUPITER_ULTRA_CLIENT_PLATFORM)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signedTransaction: params.signedTransaction,
        requestId: params.requestId,
      }),
    },
  );
}

/** Client-side via Next.js proxy */
export async function fetchUltraOrder(
  params: UltraOrderParams,
): Promise<UltraOrderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ULTRA_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${getClientBaseUrl()}/api/jupiter/ultra/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as UltraOrderResponse & {
      error?: string;
    };

    if (!response.ok) {
      throw new JupiterUltraError(
        payload.error || `Ultra order proxy failed (${response.status})`,
        response.status,
      );
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/** Client-side via Next.js proxy */
export async function fetchUltraExecute(
  params: UltraExecuteParams,
): Promise<UltraExecuteResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ULTRA_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${getClientBaseUrl()}/api/jupiter/ultra/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as UltraExecuteResponse & {
      error?: string;
    };

    if (!response.ok) {
      throw new JupiterUltraError(
        payload.error || `Ultra execute proxy failed (${response.status})`,
        response.status,
      );
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function parseUltraOrderTransaction(
  response: UltraOrderResponse,
): { transaction: string; requestId: string } {
  const transaction = extractTransactionBase64(response);
  const requestId = extractUltraRequestId(response);
  if (!transaction) {
    throw new JupiterUltraError("Ultra order response missing transaction");
  }
  if (!requestId) {
    throw new JupiterUltraError("Ultra order response missing requestId");
  }
  return { transaction, requestId };
}

export function parseUltraOutAmount(response: UltraOrderResponse): string | undefined {
  const raw =
    response.outAmount ??
    response.outputAmount ??
    response.out_amount ??
    response.output_amount;
  return raw != null ? String(raw) : undefined;
}
