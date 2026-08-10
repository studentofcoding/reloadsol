import { NextRequest, NextResponse } from "next/server";
import {
  fetchUltraExecuteDirect,
  JupiterUltraError,
  type UltraExecuteParams,
} from "@/utils/jupiter-ultra";


export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<UltraExecuteParams>;

    if (!body.signedTransaction || !body.requestId) {
      return NextResponse.json(
        { error: "signedTransaction and requestId are required" },
        { status: 400 },
      );
    }

    const start = Date.now();
    const result = await fetchUltraExecuteDirect({
      signedTransaction: body.signedTransaction,
      requestId: body.requestId,
    });

    return NextResponse.json(
      { ...result, latencyMs: Date.now() - start },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Jupiter Ultra execute proxy error:", error);
    if (error instanceof JupiterUltraError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode ?? 502 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
