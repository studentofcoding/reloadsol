import { NextRequest, NextResponse } from "next/server";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { requireDevSession } from "@/utils/api-auth";
import { createRpcConnection } from "@/utils/rpc-urls";
import {
  composeTriArbAtomicTransaction,
  isSolArbLiveEnabled,
  loadSolArbKeypair,
} from "@/utils/sol-arb";
import {
  submitSignedSwap,
  confirmSwapSignature,
} from "@/utils/swap-executor";


export async function POST(req: NextRequest) {
  const auth = requireDevSession(req);
  if (auth instanceof NextResponse) return auth;

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
    if (!mintA || !mintB) {
      return NextResponse.json(
        { error: "mintA and mintB are required" },
        { status: 400 },
      );
    }

    const mode = body.mode ?? "prepare";

    if (mode === "live" && !isSolArbLiveEnabled()) {
      return NextResponse.json(
        { error: "SOL_ARB_LIVE_ENABLED is not true" },
        { status: 403 },
      );
    }

    let connection;
    try {
      connection = createRpcConnection();
    } catch {
      return NextResponse.json({ error: "RPC not configured" }, { status: 500 });
    }

    const userPublicKey =
      mode === "live"
        ? loadSolArbKeypair().publicKey.toBase58()
        : body.userPublicKey?.trim();

    if (!userPublicKey) {
      return NextResponse.json(
        { error: "userPublicKey required for prepare mode" },
        { status: 400 },
      );
    }
    try {
      new PublicKey(userPublicKey);
    } catch {
      return NextResponse.json({ error: "Invalid userPublicKey" }, { status: 400 });
    }

    const composed = await composeTriArbAtomicTransaction({
      mintA,
      mintB,
      amountLamports: body.amountLamports ?? "100000000",
      userPublicKey,
      connection,
      slippageBps: body.slippageBps,
      priorityFeeLamports: body.priorityFeeLamports,
    });

    if (mode === "prepare") {
      return NextResponse.json({
        success: true,
        quote: composed.quote,
        swapTransaction: composed.swapTransaction,
        expectedOutSolLamports: composed.expectedOutSolLamports,
      });
    }

    if (mode === "live") {
      const keypair = loadSolArbKeypair();
      const tx = VersionedTransaction.deserialize(
        Buffer.from(composed.swapTransaction, "base64"),
      );
      tx.sign([keypair]);
      const sendResult = await submitSignedSwap({
        signedTx: tx,
        prepared: {
          provider: "jupiter_lite",
          swapTransaction: composed.swapTransaction,
          outAmount: composed.expectedOutSolLamports,
        },
        connection,
        direct: true,
      });
      await confirmSwapSignature({
        signature: sendResult.signature,
        via: sendResult.via,
        checkViaRaptor: sendResult.checkViaRaptor,
        connection,
        blockhash: tx.message.recentBlockhash,
        direct: true,
      });
      return NextResponse.json({
        success: true,
        signature: sendResult.signature,
        quote: composed.quote,
        expectedOutSolLamports: composed.expectedOutSolLamports,
      });
    }

    return NextResponse.json({ error: "mode must be prepare or live" }, { status: 400 });
  } catch (error) {
    console.error("sol-arb execute-atomic error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Atomic compose/execute failed",
      },
      { status: 502 },
    );
  }
}
