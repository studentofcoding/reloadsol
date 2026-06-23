import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  fetchRaptorQuoteAndSwapDirect,
  RaptorAPIError,
  type RaptorQuoteAndSwapParams,
} from "@/utils/solanatracker-raptor";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<RaptorQuoteAndSwapParams>;

    if (
      !body.userPublicKey ||
      !body.inputMint ||
      !body.outputMint ||
      body.amount === undefined ||
      body.amount === null
    ) {
      return NextResponse.json(
        {
          error:
            "userPublicKey, inputMint, outputMint, amount, and slippageBps are required",
        },
        { status: 400 },
      );
    }

    try {
      new PublicKey(body.userPublicKey);
      new PublicKey(body.inputMint);
      new PublicKey(body.outputMint);
    } catch {
      return NextResponse.json(
        { error: "Invalid wallet or mint address" },
        { status: 400 },
      );
    }

    const amountStr = String(body.amount);
    if (!/^\d+$/.test(amountStr) || Number(amountStr) <= 0) {
      return NextResponse.json(
        { error: "amount must be a positive integer (smallest units)" },
        { status: 400 },
      );
    }

    const start = Date.now();
    const result = await fetchRaptorQuoteAndSwapDirect({
      userPublicKey: body.userPublicKey,
      inputMint: body.inputMint,
      outputMint: body.outputMint,
      amount: amountStr,
      slippageBps: body.slippageBps ?? 200,
      priorityFeeLamports: body.priorityFeeLamports,
      feeAccount: body.feeAccount,
      feeBps: body.feeBps,
    });

    return NextResponse.json(
      { ...result, latencyMs: Date.now() - start },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Raptor swap proxy error:", error);
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
