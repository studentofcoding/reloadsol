import { NextRequest, NextResponse } from "next/server";
import {
  RaptorAPIError,
  sendRaptorTransactionDirect,
} from "@/utils/solanatracker-raptor";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { transaction?: string };

    if (!body.transaction) {
      return NextResponse.json(
        { error: "transaction (signed base64) is required" },
        { status: 400 },
      );
    }

    const result = await sendRaptorTransactionDirect(body.transaction);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Raptor send proxy error:", error);
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
