import { NextRequest, NextResponse, connection } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getShyftApiKey, ShyftAPIError } from "@/utils/shyft-api";
import { fetchShyftAllTokensDirect } from "@/utils/shyft-wallet";

export async function GET(request: NextRequest) {
  try {
    await connection()
    const apiKey = getShyftApiKey();
    if (!apiKey) {
      return NextResponse.json(
        {
          status: "error",
          error:
            "SHYFT_API_KEY not configured. Set it in .env (https://shyft.to dashboard).",
        },
        { status: 503 },
      );
    }

    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get("wallet");
    const network = searchParams.get("network") ?? "mainnet-beta";

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

    const result = await fetchShyftAllTokensDirect(wallet, network);

    return NextResponse.json(
      {
        status: "success",
        tokens: result.tokens,
        tokenCount: result.tokenCount,
        latencyMs: result.latencyMs,
      },
      {
        headers: {
          "Cache-Control": "private, max-age=15",
        },
      },
    );
  } catch (error) {
    console.error("Shyft all_tokens proxy error:", error);

    if (error instanceof ShyftAPIError) {
      return NextResponse.json(
        {
          status: "error",
          error: error.message,
        },
        { status: error.statusCode ?? 502 },
      );
    }

    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    );
  }
}
