import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { createRpcConnection } from "@/utils/rpc-urls";
import {
  executeTriArbSequential,
  isSolArbLiveEnabled,
  loadSolArbKeypair,
  prepareTriArbLegs,
} from "@/utils/sol-arb";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      mode?: "prepare" | "live";
      mintA?: string;
      mintB?: string;
      amountLamports?: string | number;
      slippageBps?: number;
      priorityFeeLamports?: number;
      userPublicKey?: string;
    };

    const mintA = body.mintA?.trim();
    const mintB = body.mintB?.trim();
    const userPublicKey = body.userPublicKey?.trim();
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

    const mode = body.mode ?? "prepare";

    if (mode === "prepare") {
      if (!userPublicKey) {
        return NextResponse.json(
          { error: "userPublicKey required for prepare mode" },
          { status: 400 },
        );
      }
      try {
        new PublicKey(userPublicKey);
      } catch {
        return NextResponse.json(
          { error: "Invalid userPublicKey" },
          { status: 400 },
        );
      }

      const prepared = await prepareTriArbLegs({
        mintA,
        mintB,
        amountLamports,
        slippageBps: body.slippageBps,
        priorityFeeLamports: body.priorityFeeLamports,
        userPublicKey,
      });
      return NextResponse.json({ success: true, ...prepared });
    }

    if (mode === "live") {
      if (!isSolArbLiveEnabled()) {
        return NextResponse.json(
          { error: "SOL_ARB_LIVE_ENABLED is not true" },
          { status: 403 },
        );
      }
      const keypair = loadSolArbKeypair();
      let connection;
      try {
        connection = createRpcConnection();
      } catch {
        return NextResponse.json(
          { error: "RPC not configured" },
          { status: 500 },
        );
      }

      const result = await executeTriArbSequential({
        mintA,
        mintB,
        amountLamports,
        slippageBps: body.slippageBps,
        priorityFeeLamports: body.priorityFeeLamports,
        userPublicKey: keypair.publicKey.toBase58(),
        connection,
        signTransaction: async (tx) => {
          tx.sign([keypair]);
          return tx;
        },
      });

      return NextResponse.json({
        success: result.success,
        aborted: result.aborted,
        abortLeg: result.abortLeg,
        quote: result.quote,
        legs: result.legs,
      });
    }

    return NextResponse.json({ error: "mode must be prepare or live" }, { status: 400 });
  } catch (error) {
    console.error("sol-arb execute error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Execute failed" },
      { status: 502 },
    );
  }
}
