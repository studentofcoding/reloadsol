import { NextRequest, NextResponse, connection } from "next/server";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { TOKENS } from "@/utils/solana";
import { fetchWithCache, portfolioKey } from "@/utils/portfolio-cache";

const BALANCE_TTL_SECONDS = 12;
const BALANCE_STALE_TTL_SECONDS = 120;

const DEFAULT_RPC =
  process.env.NEXT_PUBLIC_RPC_URL ??
  process.env.RPC_URL ??
  "https://api.mainnet-beta.solana.com";

type SolBalance = { balance: number; usdc: number; latencyMs: number };

async function fetchSolBalance(wallet: string): Promise<SolBalance> {
  const start = Date.now();
  const connection = new Connection(DEFAULT_RPC, { commitment: "confirmed" });
  const publicKey = new PublicKey(wallet);

  const lamports = await connection.getBalance(publicKey);

  let usdc = 0;
  try {
    const usdcMint = new PublicKey(TOKENS.USDC);
    const ata = await getAssociatedTokenAddress(usdcMint, publicKey);
    const account = await getAccount(connection, ata);
    usdc = Number(account.amount) / 1e6;
  } catch {
    usdc = 0;
  }

  return {
    balance: lamports / LAMPORTS_PER_SOL,
    usdc,
    latencyMs: Date.now() - start,
  };
}

/** Cached Solana native + USDC balance. `fresh=1` bypasses + purges the key. */
export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  try {
    await connection();
    const wallet = request.nextUrl.searchParams.get("wallet")?.trim() ?? "";
    if (!wallet) {
      return NextResponse.json(
        { error: "wallet query parameter is required" },
        { status: 400 },
      );
    }
    try {
      new PublicKey(wallet);
    } catch {
      return NextResponse.json(
        { error: "Invalid wallet address" },
        { status: 400 },
      );
    }

    const skipCache = request.nextUrl.searchParams.get("fresh") === "1";
    const freshKey = portfolioKey("sol", wallet, "balance");

    const { data, origin } = await fetchWithCache<SolBalance>({
      key: freshKey,
      staleKey: `${freshKey}:stale`,
      ttlSeconds: BALANCE_TTL_SECONDS,
      staleTtlSeconds: BALANCE_STALE_TTL_SECONDS,
      skipCache,
      fetch: () => fetchSolBalance(wallet),
    });

    return NextResponse.json({
      ...data,
      source: "sol-rpc",
      cache: origin,
    });
  } catch (error) {
    console.error("Sol portfolio proxy error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    );
  }
}