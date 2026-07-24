/**
 * Uniswap Interface GraphQL — discovers v4 pools DexScreener misses.
 * Query: topV4Pools(chain, tokenFilter)
 */
import type { Address, Hex } from 'viem';
import type { SupportedChainId } from './config';

const GQL = 'https://interface.gateway.uniswap.org/v1/graphql';

/** GraphQL Chain enum values used by Uniswap data API */
const CHAIN_GQL: Record<SupportedChainId, string> = {
  4663: 'ROBINHOOD',
};

export type ExploreV4Pool = {
  poolId: Hex;
  fee: number;
  tvlUsd: number;
  /** null address means native ETH/BNB */
  currency0: Address | null;
  currency1: Address | null;
  symbol0: string;
  symbol1: string;
};

function decodeV4PoolId(gqlId: string): Hex | null {
  try {
    const raw = new TextDecoder().decode(Uint8Array.from(atob(gqlId), (c) => c.charCodeAt(0)));
    // "V4Pool:ROBINHOOD_0xabc..." or "V4Pool:BNB_0x..."
    const m = raw.match(/0x[a-fA-F0-9]{64}/);
    if (!m) return null;
    return m[0].toLowerCase() as Hex;
  } catch {
    return null;
  }
}

/**
 * Top Uniswap v4 pools for a token (same source as app.uniswap.org explore).
 */
export async function fetchTopV4Pools(
  chainId: SupportedChainId,
  tokenAddress: Address,
  first = 25,
): Promise<ExploreV4Pool[]> {
  const chain = CHAIN_GQL[chainId];
  if (!chain) return [];

  const query = `
    query TopV4($chain: Chain!, $token: String!, $first: Int!) {
      topV4Pools(chain: $chain, tokenFilter: $token, first: $first) {
        id
        protocolVersion
        feeTier
        totalLiquidity { value }
        token0 { symbol address }
        token1 { symbol address }
      }
    }
  `;

  const res = await fetch(GQL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.uniswap.org',
      'user-agent': 'lp-uniswap-bot/1.0',
    },
    body: JSON.stringify({
      query,
      variables: {
        chain,
        token: tokenAddress.toLowerCase(),
        first,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Uniswap explore HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    data?: {
      topV4Pools?: {
        id: string;
        feeTier: number;
        totalLiquidity?: { value?: number };
        token0?: { symbol?: string; address?: string | null };
        token1?: { symbol?: string; address?: string | null };
      }[];
    };
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }

  const pools = json.data?.topV4Pools ?? [];
  const out: ExploreV4Pool[] = [];

  for (const p of pools) {
    const poolId = decodeV4PoolId(p.id);
    if (!poolId) continue;
    const fee = Math.round(Number(p.feeTier) || 0);
    if (fee <= 0) continue;

    const a0 = p.token0?.address;
    const a1 = p.token1?.address;
    out.push({
      poolId,
      fee,
      tvlUsd: Number(p.totalLiquidity?.value) || 0,
      currency0: a0 ? (a0 as Address) : null,
      currency1: a1 ? (a1 as Address) : null,
      symbol0: p.token0?.symbol ?? '???',
      symbol1: p.token1?.symbol ?? '???',
    });
  }

  out.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return out;
}
