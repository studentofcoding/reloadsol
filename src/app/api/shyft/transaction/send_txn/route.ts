import { NextRequest, NextResponse } from "next/server";
import { getShyftApiKey, ShyftAPIError } from "@/utils/shyft-api";
import { sendShyftTransactionDirect } from "@/utils/shyft-transaction";

export const dynamic = "force-dynamic";

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
      encoded_transaction?: string;
      network?: string;
    };

    if (!body.encoded_transaction || typeof body.encoded_transaction !== "string") {
      return NextResponse.json(
        { error: "encoded_transaction is required" },
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
    const result = await sendShyftTransactionDirect(
      body.encoded_transaction,
      network,
    );

    return NextResponse.json(
      { ...result, latencyMs: Date.now() - start },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Shyft send_txn proxy error:", error);
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
