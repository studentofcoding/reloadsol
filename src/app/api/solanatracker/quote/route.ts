import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  fetchRaptorQuoteDirect,
  RaptorAPIError,
} from "@/utils/solanatracker-raptor";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const inputMint = searchParams.get("inputMint");
    const outputMint = searchParams.get("outputMint");
    const amount = searchParams.get("amount");
    const slippageBps = Number.parseInt(
      searchParams.get("slippageBps") ?? "200",
      10,
    );

    if (!inputMint || !outputMint || !amount) {
      return NextResponse.json(
        { error: "inputMint, outputMint, and amount are required" },
        { status: 400 },
      );
    }

    try {
      new PublicKey(inputMint);
      new PublicKey(outputMint);
    } catch {
      return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
    }

    if (!/^\d+$/.test(amount) || Number(amount) <= 0) {
      return NextResponse.json(
        { error: "amount must be a positive integer (smallest units)" },
        { status: 400 },
      );
    }

    const start = Date.now();
    const quote = await fetchRaptorQuoteDirect(
      inputMint,
      outputMint,
      amount,
      Number.isFinite(slippageBps) ? slippageBps : 200,
    );

    return NextResponse.json(
      { ...quote, latencyMs: Date.now() - start },
      {
        headers: { "Cache-Control": "private, max-age=10" },
      },
    );
  } catch (error) {
    console.error("Raptor quote proxy error:", error);
    if (error instanceof RaptorAPIError) {
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
