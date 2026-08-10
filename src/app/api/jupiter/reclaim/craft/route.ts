import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  fetchJupiterReclaimCraftDirect,
  JupiterReclaimError,
  RECLAIM_MAX_MINTS,
} from "@/utils/jupiter-reclaim";


export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { owner?: string; mints?: string[] };

    if (!body.owner || !Array.isArray(body.mints) || body.mints.length === 0) {
      return NextResponse.json(
        { error: "owner and a non-empty mints array are required" },
        { status: 400 },
      );
    }

    if (body.mints.length > RECLAIM_MAX_MINTS) {
      return NextResponse.json(
        { error: `mints exceeds maximum batch size of ${RECLAIM_MAX_MINTS}` },
        { status: 400 },
      );
    }

    try {
      new PublicKey(body.owner);
      for (const mint of body.mints) {
        new PublicKey(mint);
      }
    } catch {
      return NextResponse.json({ error: "Invalid owner or mint address" }, { status: 400 });
    }

    const start = Date.now();
    const result = await fetchJupiterReclaimCraftDirect(body.owner, body.mints);

    return NextResponse.json(
      { ...result, latencyMs: Date.now() - start },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Jupiter reclaim craft proxy error:", error);
    if (error instanceof JupiterReclaimError) {
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
