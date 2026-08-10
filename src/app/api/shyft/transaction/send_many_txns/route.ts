import { NextRequest, NextResponse } from "next/server";
import { getShyftApiKey, ShyftAPIError } from "@/utils/shyft-api";
import { sendShyftManyTransactionsDirect } from "@/utils/shyft-transaction";


const VALID_NETWORKS = new Set(["mainnet-beta", "testnet", "devnet"]);

export async function POST(request: NextRequest) {
  try {
    const apiKey = getShyftApiKey();
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "SHYFT_API_KEY not configured. Set it in .env (https://shyft.to dashboard).",
        },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      encoded_transactions?: string[];
      network?: string;
    };

    if (
      !Array.isArray(body.encoded_transactions) ||
      body.encoded_transactions.length === 0 ||
      !body.encoded_transactions.every((tx) => typeof tx === "string" && tx.length > 0)
    ) {
      return NextResponse.json(
        { error: "encoded_transactions must be a non-empty string array" },
        { status: 400 },
      );
    }

    const network = body.network ?? "mainnet-beta";
    if (!VALID_NETWORKS.has(network)) {
      return NextResponse.json(
        { error: "network must be mainnet-beta, testnet, or devnet" },
        { status: 400 },
      );
    }

    const start = Date.now();
    const result = await sendShyftManyTransactionsDirect(
      body.encoded_transactions,
      network,
    );

    return NextResponse.json(
      { ...result, latencyMs: Date.now() - start },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Shyft send_many_txns proxy error:", error);
    if (error instanceof ShyftAPIError) {
      return NextResponse.json(
        { error: error.message, success: false },
        { status: error.statusCode ?? 502 },
      );
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        success: false,
      },
      { status: 502 },
    );
  }
}
