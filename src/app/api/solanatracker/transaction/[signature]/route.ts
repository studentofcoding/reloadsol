import { NextRequest, NextResponse } from "next/server";
import {
  getRaptorTransactionStatusDirect,
  RaptorAPIError,
} from "@/utils/solanatracker-raptor";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ signature: string }> },
) {
  try {
    const { signature } = await context.params;
    if (!signature) {
      return NextResponse.json({ error: "signature is required" }, { status: 400 });
    }

    const status = await getRaptorTransactionStatusDirect(signature);
    return NextResponse.json(status, {
      headers: { "Cache-Control": "private, max-age=2" },
    });
  } catch (error) {
    console.error("Raptor transaction status proxy error:", error);
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
