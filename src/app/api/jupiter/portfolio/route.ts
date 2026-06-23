import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { fetchJupiterPortfolioDirect } from "@/utils/jupiter-portfolio";

export async function GET(request: NextRequest) {
  try {
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

    const portfolio = await fetchJupiterPortfolioDirect(wallet);

    return NextResponse.json(
      {
        status: "success",
        totalValue: portfolio.totalValue,
        tokens: portfolio.tokens,
        reclaimableCount: portfolio.reclaimableCount ?? 0,
        reclaimableLamports: portfolio.reclaimableLamports ?? 0,
        latencyMs: portfolio.latencyMs ?? 0,
      },
      {
        headers: {
          "Cache-Control": "private, max-age=15",
        },
      },
    );
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
