import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildEndpointList,
  parseIndexRpcError,
  resolveRpcUrls,
  type RpcEndpointInfo,
} from "@/utils/rpc-urls";

export type { RpcEndpointInfo };

export async function GET() {
  try {
    const rpcUrls = resolveRpcUrls();
    if (rpcUrls.length === 0) {
      return NextResponse.json(
        { error: "RPC not configured. Set RPC_URL or SHYFT_API_KEY in .env" },
        { status: 503 },
      );
    }

    const endpoints = buildEndpointList(rpcUrls);

    return NextResponse.json({
      status: "success",
      timestamp: new Date().toISOString(),
      endpoints,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export type RpcDiagnosticRow = {
  index: number;
  provider: string;
  sanitizedUrl: string;
  slotHealthy: boolean;
  indexHealthy: boolean;
  healthy: boolean;
  getSlotMs: number;
  getParsedTokenAccountsMs: number;
  rawAccountCount: number;
  slotError?: string;
  indexError?: string;
  error?: string;
};

async function probeEndpoint(
  url: string,
  index: number,
  wallet: PublicKey,
): Promise<RpcDiagnosticRow> {
  const endpoint = buildEndpointList([url])[0];
  const provider = endpoint?.provider ?? "Custom";
  const sanitizedUrl = endpoint?.sanitizedUrl ?? url;
  const connection = new Connection(url, "confirmed");

  let getSlotMs = 0;
  let getParsedTokenAccountsMs = 0;
  let rawAccountCount = 0;
  let slotHealthy = false;
  let indexHealthy = false;
  let slotError: string | undefined;
  let indexError: string | undefined;

  try {
    const slotStart = Date.now();
    await connection.getSlot();
    getSlotMs = Date.now() - slotStart;
    slotHealthy = true;
  } catch (error) {
    slotError = error instanceof Error ? error.message : String(error);
  }

  if (slotHealthy) {
    try {
      const accountsStart = Date.now();
      const { value } = await connection.getParsedTokenAccountsByOwner(wallet, {
        programId: TOKEN_PROGRAM_ID,
      });
      getParsedTokenAccountsMs = Date.now() - accountsStart;
      rawAccountCount = value.length;
      indexHealthy = true;
    } catch (error) {
      indexError = parseIndexRpcError(error);
    }
  } else {
    indexError = slotError
      ? "Skipped — slot probe failed"
      : "Skipped — slot probe failed";
  }

  const healthy = slotHealthy && indexHealthy;
  const error = !healthy
    ? indexError ?? slotError ?? "RPC probe failed"
    : undefined;

  return {
    index,
    provider,
    sanitizedUrl,
    slotHealthy,
    indexHealthy,
    healthy,
    getSlotMs,
    getParsedTokenAccountsMs,
    rawAccountCount,
    slotError,
    indexError,
    error,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const walletAddress = body?.walletAddress as string | undefined;
    const endpointIndex =
      typeof body?.endpointIndex === "number" ? body.endpointIndex : undefined;

    if (!walletAddress) {
      return NextResponse.json(
        { error: "walletAddress is required" },
        { status: 400 },
      );
    }

    let wallet: PublicKey;
    try {
      wallet = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json(
        { error: "Invalid walletAddress" },
        { status: 400 },
      );
    }

    const rpcUrls = resolveRpcUrls();
    if (rpcUrls.length === 0) {
      return NextResponse.json(
        { error: "RPC not configured. Set RPC_URL or SHYFT_API_KEY in .env" },
        { status: 503 },
      );
    }

    const indices =
      endpointIndex !== undefined ? [endpointIndex] : rpcUrls.map((_, i) => i);

    const results = await Promise.all(
      indices.map(async (index) => {
        const url = rpcUrls[index];
        if (!url) {
          return {
            index,
            provider: "Unknown",
            sanitizedUrl: "Invalid index",
            slotHealthy: false,
            indexHealthy: false,
            healthy: false,
            getSlotMs: 0,
            getParsedTokenAccountsMs: 0,
            rawAccountCount: 0,
            error: `Endpoint index ${index} not configured`,
          } satisfies RpcDiagnosticRow;
        }
        return probeEndpoint(url, index, wallet);
      }),
    );

    const bestByCount = [...results]
      .filter((r) => r.indexHealthy)
      .sort((a, b) => {
        if (b.rawAccountCount !== a.rawAccountCount) {
          return b.rawAccountCount - a.rawAccountCount;
        }
        return a.getParsedTokenAccountsMs - b.getParsedTokenAccountsMs;
      })[0];

    return NextResponse.json({
      status: "success",
      timestamp: new Date().toISOString(),
      walletAddress,
      results,
      recommendedIndex: bestByCount?.index ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
