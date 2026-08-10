import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { quoteTriArb } from "@/utils/sol-arb";


export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      mintA?: string;
      mintB?: string;
      amountLamports?: string | number;
      slippageBps?: number;
    };

    const mintA = body.mintA?.trim();
    const mintB = body.mintB?.trim();
    if (!mintA || !mintB) {
      return NextResponse.json(
        { error: "mintA and mintB are required" },
        { status: 400 },
      );
    }
    try {
      new PublicKey(mintA);
      new PublicKey(mintB);
    } catch {
      return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
    }

    const amountLamports = body.amountLamports;
    if (
      amountLamports == null ||
      !/^\d+$/.test(String(amountLamports)) ||
      BigInt(String(amountLamports)) <= BigInt(0)
    ) {
      return NextResponse.json(
        { error: "amountLamports must be a positive integer" },
        { status: 400 },
      );
    }

    const quote = await quoteTriArb({
      mintA,
      mintB,
      amountLamports,
      slippageBps: body.slippageBps,
    });

    return NextResponse.json({ success: true, quote });
  } catch (error) {
    console.error("sol-arb quote error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Quote failed" },
      { status: 502 },
    );
  }
}
