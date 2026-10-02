import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy for the Shyft **RPC** `sendTransaction` lane used by the serialised batch landing.
 *
 * The batch submit runs in the browser, but `SHYFT_RPC_URL` is a server-only env — Next inlines only
 * `NEXT_PUBLIC_*` into client code, so the gate in `sendBatchViaShyftRpc` always returned null there and
 * every client batch silently fell through to Shyft's `send_many_txns` REST lane. That lane is the worst
 * of the three, measured: **417, 1 of 3 landed, 61 s** to confirm, against the serialised RPC's
 * **3 of 3 in 163 ms**. It also failed before per-tx reporting, which is how it hid a partial batch.
 *
 * This route is the server-side door to that lane. It forwards the JSON-RPC envelope unchanged so the
 * caller's parsing is identical whether it went direct or through here.
 */
const ALLOWED_METHODS = new Set(["sendTransaction"]);

export async function POST(request: NextRequest) {
  const url = process.env.SHYFT_RPC_URL?.trim();
  if (!url) {
    return NextResponse.json(
      { error: "SHYFT_RPC_URL not configured. Set it in .env (https://rpc.shyft.to?api_key=…)." },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };

    if (typeof body.method !== "string" || !ALLOWED_METHODS.has(body.method)) {
      return NextResponse.json(
        { error: "method must be sendTransaction" },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.params)) {
      return NextResponse.json({ error: "params must be an array" }, { status: 400 });
    }

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: typeof body.id === "number" ? body.id : 1,
        method: body.method,
        params: body.params,
      }),
    });

    // Pass the JSON-RPC envelope through as-is: { result } or { error }, exactly as the direct call returns.
    const json = (await upstream.json()) as Record<string, unknown>;
    return NextResponse.json(json, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Shyft rpc send_txn proxy error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
