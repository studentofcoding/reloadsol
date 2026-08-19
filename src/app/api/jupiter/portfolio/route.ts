import { NextRequest, NextResponse, connection } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { fetchJupiterPortfolioDirect } from "@/utils/jupiter-portfolio";
import { cacheGet, cacheSet } from "@/utils/redis-cache";

const PORTFOLIO_CACHE_TTL_SECONDS = 15;

function portfolioCacheKey(wallet: string): string {
  return `portfolio:${wallet}`;
}

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

    const cached = await cacheGet<{
      status: string;
      totalValue: number;
      tokens: unknown[];
      reclaimableCount: number;
      reclaimableLamports: number;
      latencyMs: number;
    }>(portfolioCacheKey(wallet));

    if (cached && !skipCache) {
      return NextResponse.json(cached, {
        headers: {
          "Cache-Control": "private, max-age=15",
          "X-Cache-Status": "HIT",
        },
      });
    }

    const portfolio = await fetchJupiterPortfolioDirect(wallet);

    const body = {
      status: "success",
      totalValue: portfolio.totalValue,
      tokens: portfolio.tokens,
      reclaimableCount: portfolio.reclaimableCount ?? 0,
      reclaimableLamports: portfolio.reclaimableLamports ?? 0,
      latencyMs: portfolio.latencyMs ?? 0,
    };

    if (!skipCache) {
      await cacheSet(portfolioCacheKey(wallet), body, PORTFOLIO_CACHE_TTL_SECONDS);
    }

    return NextResponse.json(body, {
      headers: {
        "Cache-Control": "private, max-age=15",
        "X-Cache-Status": "MISS",
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
