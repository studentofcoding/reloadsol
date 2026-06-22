import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getRpcProviderType, resolveRpcUrls } from "@/utils/rpc-urls";

const sanitizeUrl = (url: string): string => {
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.delete("api-key");
    urlObj.searchParams.delete("api_key");
    urlObj.searchParams.delete("token");
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname !== "/" ? urlObj.pathname : ""}${urlObj.search ? "?***" : ""}`;
  } catch {
    return "Invalid URL";
  }
};

export type RpcEndpointInfo = {
  index: number;
  provider: string;
  sanitizedUrl: string;
  url: string;
};

export async function GET() {
  try {
    const rpcUrls = resolveRpcUrls();
    if (rpcUrls.length === 0) {
      return NextResponse.json(
        { error: "RPC not configured. Set RPC_URL or SHYFT_API_KEY in .env" },
        { status: 503 },
      );
    }

    const endpoints: RpcEndpointInfo[] = rpcUrls.map((url, index) => ({
      index,
      provider: getRpcProviderType(url),
      sanitizedUrl: sanitizeUrl(url),
      url,
    }));

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
  healthy: boolean;
  getSlotMs: number;
  getParsedTokenAccountsMs: number;
  rawAccountCount: number;
  error?: string;
};

async function probeEndpoint(
  url: string,
  index: number,
  wallet: PublicKey,
): Promise<RpcDiagnosticRow> {
  const provider = getRpcProviderType(url);
  const sanitizedUrl = sanitizeUrl(url);
  const connection = new Connection(url, "confirmed");

  let getSlotMs = 0;
  let getParsedTokenAccountsMs = 0;
  let rawAccountCount = 0;

  try {
    const slotStart = Date.now();
    await connection.getSlot();
    getSlotMs = Date.now() - slotStart;

    const accountsStart = Date.now();
    const { value } = await connection.getParsedTokenAccountsByOwner(wallet, {
      programId: TOKEN_PROGRAM_ID,
    });
    getParsedTokenAccountsMs = Date.now() - accountsStart;
    rawAccountCount = value.length;

    return {
      index,
      provider,
      sanitizedUrl,
      healthy: true,
      getSlotMs,
      getParsedTokenAccountsMs,
      rawAccountCount,
    };
  } catch (error) {
    return {
      index,
      provider,
      sanitizedUrl,
      healthy: false,
      getSlotMs,
      getParsedTokenAccountsMs,
      rawAccountCount,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
      .filter((r) => r.healthy)
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
