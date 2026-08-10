import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  fetchUltraOrderDirect,
  JupiterUltraError,
  type UltraOrderParams,
} from "@/utils/jupiter-ultra";


export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<UltraOrderParams>;

    if (!body.inputMint || !body.outputMint || body.amount == null || !body.taker) {
      return NextResponse.json(
        { error: "inputMint, outputMint, amount, and taker are required" },
        { status: 400 },
      );
    }

    try {
      new PublicKey(body.inputMint);
      new PublicKey(body.outputMint);
      new PublicKey(body.taker);
    } catch {
      return NextResponse.json({ error: "Invalid mint or wallet address" }, { status: 400 });
    }

    const amountStr = String(body.amount);
    if (!/^\d+$/.test(amountStr) || Number(amountStr) <= 0) {
      return NextResponse.json(
        { error: "amount must be a positive integer (smallest units)" },
        { status: 400 },
      );
    }

    const start = Date.now();
    const result = await fetchUltraOrderDirect({
      inputMint: body.inputMint,
      outputMint: body.outputMint,
      amount: amountStr,
      taker: body.taker,
      swapMode: body.swapMode ?? "ExactIn",
      slippageBps: body.slippageBps,
    });

    return NextResponse.json(
      { ...result, latencyMs: Date.now() - start },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Jupiter Ultra order proxy error:", error);
    if (error instanceof JupiterUltraError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 502 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
