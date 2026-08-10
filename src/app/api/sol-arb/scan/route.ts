import { NextRequest, NextResponse } from "next/server";
import { isSolArbScanAuthorized, runSolArbScan } from "@/utils/sol-arb";


export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    let key = searchParams.get("key");
    let notify = searchParams.get("notify") !== "false";

    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = (await req.json().catch(() => ({}))) as {
        key?: string;
        notify?: boolean;
      };
      if (body.key) key = body.key;
      if (typeof body.notify === "boolean") notify = body.notify;
    }

    if (!isSolArbScanAuthorized(key)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await runSolArbScan({ notify });
    return NextResponse.json(result);
  } catch (error) {
    console.error("sol-arb scan error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Scan failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
