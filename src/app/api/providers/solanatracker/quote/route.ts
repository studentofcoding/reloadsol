import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Legacy proxy — forwards to Raptor quote params. Prefer /api/solanatracker/quote. */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const fromAmount = searchParams.get("fromAmount");
  const amount = searchParams.get("amount");
  const slippage = searchParams.get("slippage");
  const slippageBps = searchParams.get("slippageBps");

  const inputMint = from ?? searchParams.get("inputMint");
  const outputMint = to ?? searchParams.get("outputMint");
  const rawAmount = amount ?? fromAmount;

  if (!inputMint || !outputMint || !rawAmount) {
    return NextResponse.json({ error: "Missing query params" }, { status: 400 });
  }

  let resolvedAmount = rawAmount;
  if (rawAmount.includes(".")) {
    return NextResponse.json(
      {
        error:
          "Legacy decimal fromAmount is not supported. Use raw smallest-unit amount via /api/solanatracker/quote",
      },
      { status: 400 },
    );
  }

  let resolvedSlippageBps = slippageBps ?? "200";
  if (!slippageBps && slippage) {
    const slippageNum = Number.parseFloat(slippage);
    resolvedSlippageBps = Number.isFinite(slippageNum)
      ? String(Math.round(slippageNum * 100))
      : "200";
  }

  const url = new URL("/api/solanatracker/quote", request.url);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", resolvedAmount);
  url.searchParams.set("slippageBps", resolvedSlippageBps);

  const response = await fetch(url.toString(), { cache: "no-store" });
  const payload = await response.json();
  return NextResponse.json(payload, { status: response.status });
}
