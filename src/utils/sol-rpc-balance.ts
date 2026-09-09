import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { getTradeProvider } from "@/utils/trade-provider";
import { resolveRpcUrlsForProvider, sanitizeRpcUrl } from "@/utils/rpc-urls";
import { waitForRpcRateLimit } from "@/utils/rpc-rate-limit";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Per-endpoint JSON-RPC timeout (ms). A hung provider must not hold the route. */
export const RPC_ATTEMPT_TIMEOUT_MS = 6_000;
/** Hard ceiling for the whole failover pass so a fully-down RPC set stays bounded. */
export const RPC_TOTAL_DEADLINE_MS = 15_000;

export type SolBalance = {
  balance: number;
  usdc: number;
  latencyMs: number;
  /** Endpoint that answered (raw URL — never put into a client response). */
  endpoint: string;
};

async function rpcPost(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ result?: unknown; error?: { message?: string } }> {
  await waitForRpcRateLimit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBalanceFromEndpoint(
  url: string,
  wallet: string,
  timeoutMs: number,
): Promise<{ balance: number; usdc: number }> {
  const lamportsResp = await rpcPost(
    url,
    { jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet] },
    timeoutMs,
  );
  if (lamportsResp.error || typeof lamportsResp.result === "undefined") {
    throw new Error(
      `getBalance failed: ${
        lamportsResp.error?.message ?? "empty result"
      }`,
    );
  }
  const lamports = Number(
    (lamportsResp.result as { value: number }).value ?? 0,
  );

  // USDC ATA read is best-effort — a missing/odd account is not fatal.
  let usdc = 0;
  try {
    const publicKey = new PublicKey(wallet);
    const ata = await getAssociatedTokenAddress(
      new PublicKey(USDC_MINT),
      publicKey,
    );
    const ataResp = await rpcPost(
      url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "getTokenAccountBalance",
        params: [ata.toBase58()],
      },
      timeoutMs,
    );
    if (!ataResp.error) {
      const amount = (ataResp.result as { value?: { amount?: string } })
        ?.value?.amount;
      if (amount) usdc = Number(amount) / 1e6;
    }
  } catch {
    usdc = 0;
  }

  return { balance: lamports / LAMPORTS_PER_SOL, usdc };
}

// Remember the last endpoint that answered so subsequent requests front-load it
// instead of paying a timeout on a dead primary every time.
let lastGoodEndpoint: string | null = null;

function orderedEndpoints(endpoints: string[]): string[] {
  if (!lastGoodEndpoint || !endpoints.includes(lastGoodEndpoint)) {
    return endpoints;
  }
  return [
    lastGoodEndpoint,
    ...endpoints.filter((url) => url !== lastGoodEndpoint),
  ];
}

/**
 * Resolve the configured Solana RPC endpoints and read native SOL + USDC with
 * per-endpoint timeout and failover. First endpoint that returns a balance wins.
 */
export async function fetchSolBalanceWithFailover(
  wallet: string,
  options?: {
    endpoints?: string[];
    timeoutMs?: number;
    totalDeadlineMs?: number;
  },
): Promise<SolBalance> {
  const timeoutMs = options?.timeoutMs ?? RPC_ATTEMPT_TIMEOUT_MS;
  const deadline =
    Date.now() + (options?.totalDeadlineMs ?? RPC_TOTAL_DEADLINE_MS);
  const customEndpoints = options?.endpoints;
  const endpoints =
    customEndpoints && customEndpoints.length > 0
      ? customEndpoints
      : resolveRpcUrlsForProvider(getTradeProvider());

  if (endpoints.length === 0) {
    throw new Error(
      "RPC not configured. Set RPC_URL or SHYFT_API_KEY in .env (https://rpc.shyft.to?api_key=...)",
    );
  }

  const start = Date.now();
  let lastError: Error | null = null;

  for (const url of orderedEndpoints(endpoints)) {
    if (Date.now() >= deadline) break;
    const attemptBudget = Math.min(
      timeoutMs,
      Math.max(1_000, deadline - Date.now()),
    );
    try {
      const { balance, usdc } = await fetchBalanceFromEndpoint(
        url,
        wallet,
        attemptBudget,
      );
      lastGoodEndpoint = url;
      return {
        balance,
        usdc,
        latencyMs: Date.now() - start,
        endpoint: url,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `[sol-rpc-balance] endpoint failed (${sanitizeRpcUrl(url)}):`,
        lastError.message,
      );
    }
  }

  throw (
    lastError ??
    new Error("All configured Solana RPC endpoints failed or timed out")
  );
}
