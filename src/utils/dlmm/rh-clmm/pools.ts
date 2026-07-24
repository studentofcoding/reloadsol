import type { Address, Hex } from 'viem';
import { CHAINS, type ProtocolVersion, type SupportedChainId } from './config';
import { factoryAbi, poolAbi } from './abis';
import { getPublicClient } from './clients';
import { fetchUniswapV3PoolsForToken, type DexPair } from './dexscreener';
import { getTokenMeta, type TokenMeta } from './tokens';
import { listV4PoolsForToken, type ListedV4Pool, type V4PoolKey } from './v4';

/** Hide dust / noise pools in the picker (USD TVL) */
export const MIN_POOL_TVL_USD = 2_000;

export type PoolInfo = {
  address: Address;
  token0: TokenMeta;
  token1: TokenMeta;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tvlUsd?: number;
  dexUrl?: string;
  /** Other token relative to user CA */
  quoteSymbol: string;
  baseSymbol: string;
};

export type ListedPool = {
  protocol: ProtocolVersion;
  pair: DexPair;
  /** v3: pool contract address; v4: poolId (bytes32 hex) */
  poolAddress: string;
  fee: number | null;
  tvlUsd: number;
  token0: Address;
  token1: Address;
  otherSymbol: string;
  otherAddress: Address;
  label: string;
  /** v4 only */
  poolId?: Hex;
  poolKey?: V4PoolKey;
};

const ZERO = '0x0000000000000000000000000000000000000000';

export async function listPoolsForToken(
  chainId: SupportedChainId,
  tokenCa: Address,
): Promise<ListedPool[]> {
  const [v3, v4] = await Promise.all([
    listV3PoolsForToken(chainId, tokenCa),
    listV4PoolsForToken(chainId, tokenCa).catch((e) => {
      console.warn('[listPools] v4 failed', e instanceof Error ? e.message : e);
      return [] as ListedV4Pool[];
    }),
  ]);

  const merged: ListedPool[] = [
    ...v3,
    ...v4.map(
      (p): ListedPool => ({
        protocol: 'v4',
        pair: p.pair,
        poolAddress: p.poolId,
        fee: p.fee,
        tvlUsd: p.tvlUsd,
        token0: p.token0,
        token1: p.token1,
        otherSymbol: p.otherSymbol,
        otherAddress: p.otherAddress,
        label: p.label,
        poolId: p.poolId,
        poolKey: p.poolKey,
      }),
    ),
  ];

  const filtered = merged.filter((p) => (p.tvlUsd ?? 0) >= MIN_POOL_TVL_USD);
  filtered.sort((a, b) => b.tvlUsd - a.tvlUsd);
  if (merged.length && !filtered.length) {
    console.warn(
      `[pools] all ${merged.length} pool(s) below min TVL $${MIN_POOL_TVL_USD}`,
    );
  } else if (merged.length > filtered.length) {
    console.log(
      `[pools] showing ${filtered.length}/${merged.length} (min TVL $${MIN_POOL_TVL_USD})`,
    );
  }
  return filtered;
}

async function listV3PoolsForToken(
  chainId: SupportedChainId,
  tokenCa: Address,
): Promise<ListedPool[]> {
  const pairs = await fetchUniswapV3PoolsForToken(chainId, tokenCa);
  const client = getPublicClient(chainId);
  const out: ListedPool[] = [];

  for (const pair of pairs) {
    const poolAddress = pair.pairAddress as Address;
    try {
      const [token0, token1, fee] = await Promise.all([
        client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token0' }),
        client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token1' }),
        client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'fee' }),
      ]);

      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      const ca = tokenCa.toLowerCase();
      if (t0 !== ca && t1 !== ca) continue;

      const otherIs0 = t0 !== ca;
      const otherAddress = (otherIs0 ? token0 : token1) as Address;

      let sym = otherAddress;
      let symbol = '?';
      if (pair.baseToken.address.toLowerCase() === otherAddress.toLowerCase()) {
        symbol = pair.baseToken.symbol;
      } else if (pair.quoteToken.address.toLowerCase() === otherAddress.toLowerCase()) {
        symbol = pair.quoteToken.symbol;
      } else {
        symbol = otherIs0 ? pair.baseToken.symbol : pair.quoteToken.symbol;
      }
      void sym;

      const feeNum = Number(fee);
      const tvlUsd = pair.liquidity?.usd ?? 0;
      const feeLabel = feeNum ? `${(feeNum / 10000).toFixed(2)}%` : '?';
      out.push({
        protocol: 'v3',
        pair,
        poolAddress,
        fee: feeNum,
        tvlUsd,
        token0: token0 as Address,
        token1: token1 as Address,
        otherSymbol: symbol,
        otherAddress,
        label: `v3 · ${symbol} · fee ${feeLabel} · TVL $${tvlUsd.toFixed(0)}`,
      });
    } catch {
      // skip non-v3 or broken
    }
  }

  const seen = new Set<string>();
  const unique = out.filter((p) => {
    const k = p.poolAddress.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  unique.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return unique;
}

export async function loadPool(
  chainId: SupportedChainId,
  poolAddress: Address,
): Promise<PoolInfo> {
  const client = getPublicClient(chainId);
  const [token0Addr, token1Addr, fee, tickSpacing, slot0, liquidity] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'fee' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'tickSpacing' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'liquidity' }),
  ]);

  const [token0, token1] = await Promise.all([
    getTokenMeta(chainId, token0Addr as Address),
    getTokenMeta(chainId, token1Addr as Address),
  ]);

  return {
    address: poolAddress,
    token0,
    token1,
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    sqrtPriceX96: slot0[0] as bigint,
    tick: Number(slot0[1]),
    liquidity: liquidity as bigint,
    baseSymbol: token0.symbol,
    quoteSymbol: token1.symbol,
  };
}

export async function resolvePoolFromFactory(
  chainId: SupportedChainId,
  tokenA: Address,
  tokenB: Address,
  fee: number,
): Promise<Address | null> {
  const client = getPublicClient(chainId);
  const pool = await client.readContract({
    address: CHAINS[chainId].factory,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [tokenA, tokenB, fee],
  });
  if (!pool || pool.toLowerCase() === ZERO) return null;
  return pool as Address;
}
