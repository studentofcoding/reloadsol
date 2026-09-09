import { NextRequest, NextResponse, connection } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { fetchSolBalanceWithFailover } from "@/utils/sol-rpc-balance";
import { fetchWithCache, portfolioKey } from "@/utils/portfolio-cache";

const BALANCE_TTL_SECONDS = 12;
// Long stale window so a provider outage serves last-known-good balances
// instead of a wall of 502s while the failover list is exhausted.
const BALANCE_STALE_TTL_SECONDS = 300;

/** Snapshot shape persisted in cache (endpoint URL stays server-internal). */
type BalanceSnapshot = {
  balance: number;
  usdc: number;
  latencyMs: number;
};

/** Cached Solana native + USDC balance with multi-RPC failover. `fresh=1` bypasses + purges the key. */
export async function GET(request: NextRequest) {
  await connection(); // Next.js dynamic-API opt-in (forces dynamic render)
  try {
    const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? "";
    if (!wallet) {
      return NextResponse.json(
        { error: "wallet query parameter is required" },
        { status: 400 },
      );
    }
    try {
      new PublicKey(wallet);
    } catch {
      return NextResponse.json(
        { error: "Invalid wallet address" },
        { status: 400 },
      );
    }

    const skipCache = request.nextUrl.searchParams.get("fresh") === "1";
    const freshKey = portfolioKey("sol", wallet, "balance");

    const { data, origin } = await fetchWithCache<BalanceSnapshot>({
      key: freshKey,
      staleKey: `${freshKey}:stale`,
      ttlSeconds: BALANCE_TTL_SECONDS,
      staleTtlSeconds: BALANCE_STALE_TTL_SECONDS,
      skipCache,
      fetch: async () => {
        // `endpoint` carries an API key — strip it before the snapshot is cached.
        const { balance, usdc, latencyMs } =
          await fetchSolBalanceWithFailover(wallet);
        return { balance, usdc, latencyMs };
      },
    });

    return NextResponse.json({
      ...data,
      source: "sol-rpc",
      cache: origin,
    });
  } catch (error) {
    console.error("Sol portfolio proxy error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    );
  }
}
