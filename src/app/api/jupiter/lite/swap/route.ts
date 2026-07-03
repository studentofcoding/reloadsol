import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  fetchJupiterLiteSwapDirect,
  JupiterLiteError,
  type JupiterLiteQuoteResponse,
} from "@/utils/jupiter-lite-swap";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      quoteResponse?: JupiterLiteQuoteResponse;
      userPublicKey?: string;
      priorityFeeLamports?: number;
    };

    if (!body.quoteResponse || !body.userPublicKey) {
      return NextResponse.json(
        { error: "quoteResponse and userPublicKey are required" },
        { status: 400 },
      );
    }

    try {
      new PublicKey(body.userPublicKey);
    } catch {
      return NextResponse.json(
        { error: "Invalid userPublicKey" },
        { status: 400 },
      );
    }

    const start = Date.now();
    const result = await fetchJupiterLiteSwapDirect({
      quoteResponse: body.quoteResponse,
      userPublicKey: body.userPublicKey,
      priorityFeeLamports: body.priorityFeeLamports,
    });

    return NextResponse.json(
      { ...result, latencyMs: Date.now() - start },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Jupiter Lite swap proxy error:", error);
    if (error instanceof JupiterLiteError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode ?? 502 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
