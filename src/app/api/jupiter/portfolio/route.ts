import { NextRequest, NextResponse, connection } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { fetchJupiterPortfolioDirect } from "@/utils/jupiter-portfolio";
import { fetchWithCache, portfolioKey } from "@/utils/portfolio-cache";

const PORTFOLIO_CACHE_TTL_SECONDS = 15;
const PORTFOLIO_STALE_TTL_SECONDS = 120;

type PortfolioBody = {
  status: string;
  totalValue: number;
  tokens: unknown[];
  reclaimableCount: number;
  reclaimableLamports: number;
  latencyMs: number;
};

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get("wallet");

    if (!wallet) {
      return NextResponse.json(
        { error: "wallet query parameter is required" },
        { status: 400 },
      );
    }

    try {
      new PublicKey(wallet);
    } catch {
      return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
    }

    // Post-trade refresh: bypass the response cache so the just-bought/sold
    // token shows up immediately instead of waiting out the TTL.
    const skipCache = searchParams.get("fresh") === "1";

    const freshKey = portfolioKey("sol", wallet, "holdings");
    const { origin, data } = await fetchWithCache<PortfolioBody>({
      key: freshKey,
      staleKey: `${freshKey}:stale`,
      ttlSeconds: PORTFOLIO_CACHE_TTL_SECONDS,
      staleTtlSeconds: PORTFOLIO_STALE_TTL_SECONDS,
      skipCache,
      fetch: async () => {
        const portfolio = await fetchJupiterPortfolioDirect(wallet);
        return {
          status: "success",
          totalValue: portfolio.totalValue,
          tokens: portfolio.tokens,
          reclaimableCount: portfolio.reclaimableCount ?? 0,
          reclaimableLamports: portfolio.reclaimableLamports ?? 0,
          latencyMs: portfolio.latencyMs ?? 0,
        };
      },
    });

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "private, max-age=15",
        "X-Cache-Status":
          origin === "hit" ? "HIT" : origin === "stale" ? "STALE" : "MISS",
      },
    });
  } catch (error) {
    console.error("Jupiter portfolio proxy error:", error);
    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    );
  }
}
