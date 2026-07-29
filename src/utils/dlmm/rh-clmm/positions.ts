import type { Address } from 'viem';
import { Token, Pool, Position } from './uniswap';
import { CHAINS, type SupportedChainId } from './config';
import { npmAbi, poolAbi } from './abis';
import { getHotWalletAddress, getPublicClient } from './clients';
import { getTokenMeta, formatUnits, humanToFloat } from './tokens';
import { resolvePoolFromFactory } from './pools';
import { getTokenPriceUsd, formatUsd } from './dexscreener';
import {
  formatCompactRange,
  formatEthVal,
  formatAge,
  uniswapPositionUrl,
} from './prices';
import type { ProtocolVersion } from './config';
import type { V4PoolKey, V4ListExtras } from './v4';
import type { Hex } from 'viem';

export type OnChainPosition = {
  tokenId: bigint;
  chainId: SupportedChainId;
  protocol: ProtocolVersion;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  amount0: bigint;
  amount1: bigint;
  inRange: boolean;
  currentTick: number;
  poolAddress: Address | string | null;
  valueUsd: number;
  unclaimedFeesUsd: number;
  amount0Human: number;
  amount1Human: number;
  /** v4 only */
  poolKey?: V4PoolKey;
  poolId?: Hex;
};

export async function listNpmTokenIds(chainId: SupportedChainId): Promise<bigint[]> {
  const client = getPublicClient(chainId);
  const npm = CHAINS[chainId].npm;
  const owner = getHotWalletAddress();
  const bal = await client.readContract({
    address: npm,
    abi: npmAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const ids: bigint[] = [];
  for (let i = BigInt(0); i < bal; i++) {
    const id = await client.readContract({
      address: npm,
      abi: npmAbi,
      functionName: 'tokenOfOwnerByIndex',
      args: [owner, i],
    });
    ids.push(id);
  }
  return ids;
}

export async function getPosition(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<OnChainPosition | null> {
  const client = getPublicClient(chainId);
  const npm = CHAINS[chainId].npm;
  const pos = await client.readContract({
    address: npm,
    abi: npmAbi,
    functionName: 'positions',
    args: [tokenId],
  });

  const token0 = pos[2] as Address;
  const token1 = pos[3] as Address;
  const fee = Number(pos[4]);
  const tickLower = Number(pos[5]);
  const tickUpper = Number(pos[6]);
  const liquidity = pos[7] as bigint;
  const feeGrowthInside0LastX128 = pos[8] as bigint;
  const feeGrowthInside1LastX128 = pos[9] as bigint;
  const tokensOwed0Stored = pos[10] as bigint;
  const tokensOwed1Stored = pos[11] as bigint;

  if (liquidity === BigInt(0) && tokensOwed0Stored === BigInt(0) && tokensOwed1Stored === BigInt(0)) {
    return null;
  }

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(chainId, token0),
    getTokenMeta(chainId, token1),
  ]);

  const poolAddress = await resolvePoolFromFactory(chainId, token0, token1, fee);
  let currentTick = 0;
  let amount0 = BigInt(0);
  let amount1 = BigInt(0);
  let inRange = false;
  let tokensOwed0 = tokensOwed0Stored;
  let tokensOwed1 = tokensOwed1Stored;

  if (poolAddress && liquidity > BigInt(0)) {
    const [slot0, poolLiquidity] = await Promise.all([
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' }),
      client.readContract({ address: poolAddress, abi: poolAbi, functionName: 'liquidity' }),
    ]);
    currentTick = Number(slot0[1]);
    inRange = currentTick >= tickLower && currentTick < tickUpper;

    try {
      const t0 = new Token(chainId, token0, meta0.decimals, meta0.symbol, meta0.name);
      const t1 = new Token(chainId, token1, meta1.decimals, meta1.symbol, meta1.name);
      const pool = new Pool(
        t0,
        t1,
        fee,
        (slot0[0] as bigint).toString(),
        (poolLiquidity as bigint).toString(),
        currentTick,
      );
      const position = new Position({
        pool,
        liquidity: liquidity.toString(),
        tickLower,
        tickUpper,
      });
      amount0 = BigInt(position.amount0.quotient.toString());
      amount1 = BigInt(position.amount1.quotient.toString());
    } catch {
      // amounts stay 0 if SDK fails
    }

    // Live unclaimed = tokensOwed (poked) + fee growth since last poke
    const { computeV3UnclaimedFees } = await import('./fees');
    const live = await computeV3UnclaimedFees({
      chainId,
      poolAddress,
      tickLower,
      tickUpper,
      liquidity,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      tokensOwed0: tokensOwed0Stored,
      tokensOwed1: tokensOwed1Stored,
      currentTick,
    });
    tokensOwed0 = live.fees0;
    tokensOwed1 = live.fees1;
  }

  const a0 = humanToFloat(amount0, meta0.decimals);
  const a1 = humanToFloat(amount1, meta1.decimals);
  const f0 = humanToFloat(tokensOwed0, meta0.decimals);
  const f1 = humanToFloat(tokensOwed1, meta1.decimals);

  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, token0),
    getTokenPriceUsd(chainId, token1),
  ]);
  const valueUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);
  const unclaimedFeesUsd = f0 * (p0 ?? 0) + f1 * (p1 ?? 0);

  return {
    tokenId,
    chainId,
    protocol: 'v3',
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    liquidity,
    tokensOwed0,
    tokensOwed1,
    symbol0: meta0.symbol,
    symbol1: meta1.symbol,
    decimals0: meta0.decimals,
    decimals1: meta1.decimals,
    amount0,
    amount1,
    inRange,
    currentTick,
    poolAddress,
    valueUsd,
    unclaimedFeesUsd,
    amount0Human: a0,
    amount1Human: a1,
  };
}

export async function listPositions(chainId: SupportedChainId, knownV4TokenIds?: bigint[], v4Extras?: V4ListExtras): Promise<OnChainPosition[]> {
  const t0 = Date.now();
  const { listV4Positions } = await import('./v4');
  const [v3Ids, v4] = await Promise.all([
    listNpmTokenIds(chainId),
    listV4Positions(chainId, knownV4TokenIds, v4Extras).catch((e) => {
      console.warn('[list] v4 failed', e instanceof Error ? e.message : e);
      return [] as OnChainPosition[];
    }),
  ]);
  // Parallel detail fetches (sequential was slow with many NFTs)
  const v3 = (
    await Promise.all(v3Ids.map((id) => getPosition(chainId, id).catch(() => null)))
  ).filter((p): p is OnChainPosition => p != null);
  console.log(
    `[list] chain=${chainId} v3=${v3.length}/${v3Ids.length} v4=${v4.length} ${Date.now() - t0}ms`,
  );
  return [...v3, ...v4];
}

/** Prefer non-wrapped symbol as display name */
function displayName(p: OnChainPosition): string {
  const wrapped = new Set(['WETH', 'WBNB', 'ETH', 'BNB', 'USDC', 'USDG', 'USDT']);
  if (!wrapped.has(p.symbol0.toUpperCase())) return p.symbol0;
  if (!wrapped.has(p.symbol1.toUpperCase())) return p.symbol1;
  return `${p.symbol0}/${p.symbol1}`;
}

/**
 * Compact one-liner:
 * CashDog | Age: 2h | Val: E 0.0096 ($32) | Unclaimed: E 0.0001 ($0.34) | PnL: -12.50% | 🟢 IN | Range: …
 */
export async function formatPositionLine(p: OnChainPosition): Promise<string> {
  const name = `${displayName(p)}${p.protocol === 'v4' ? ' [v4]' : ''}`;
  const age = '?';

  // Native (ETH/BNB) value: prefer actual WETH/WBNB inventory + convert other side via prices
  const wrapped = CHAINS[p.chainId].wrapped.toLowerCase();
  const nativePrice = (await getTokenPriceUsd(p.chainId, CHAINS[p.chainId].wrapped)) ?? 0;

  let valNative = 0;
  let unclNative = 0;
  if (p.token0.toLowerCase() === wrapped) {
    valNative += p.amount0Human;
    unclNative += humanToFloat(p.tokensOwed0, p.decimals0);
  } else if (nativePrice > 0) {
    const px = (await getTokenPriceUsd(p.chainId, p.token0)) ?? 0;
    if (px > 0) {
      valNative += (p.amount0Human * px) / nativePrice;
      unclNative += (humanToFloat(p.tokensOwed0, p.decimals0) * px) / nativePrice;
    }
  }
  if (p.token1.toLowerCase() === wrapped) {
    valNative += p.amount1Human;
    unclNative += humanToFloat(p.tokensOwed1, p.decimals1);
  } else if (nativePrice > 0) {
    const px = (await getTokenPriceUsd(p.chainId, p.token1)) ?? 0;
    if (px > 0) {
      valNative += (p.amount1Human * px) / nativePrice;
      unclNative += (humanToFloat(p.tokensOwed1, p.decimals1) * px) / nativePrice;
    }
  }

  // Recompute USD from native * eth price for consistency (or use p.valueUsd if already good)
  const valueUsd =
    nativePrice > 0 && valNative > 0 ? valNative * nativePrice : p.valueUsd;
  const unclaimedUsd = nativePrice > 0 ? unclNative * nativePrice : p.unclaimedFeesUsd;

  const valE = formatEthVal(valNative);
  const unclE = formatEthVal(unclNative);
  const valStr =
    valueUsd > 0 ? `${valE} (${formatUsd(valueUsd)})` : valE;
  const unclStr =
    unclaimedUsd > 0 ? `${unclE} (${formatUsd(unclaimedUsd)})` : unclE;

  const pnlStr = 'n/a';
  const status = p.inRange ? '🟢 IN' : '🔴 OUT';

  const range = formatCompactRange({
    chainId: p.chainId,
    token0: p.token0,
    token1: p.token1,
    decimals0: p.decimals0,
    decimals1: p.decimals1,
    symbol0: p.symbol0,
    symbol1: p.symbol1,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    currentTick: p.currentTick,
  });

  const link = uniswapPositionUrl(p.chainId, p.tokenId, p.protocol);

  // Attach corrected valueUsd for portfolio totals (list header uses these)
  p.valueUsd = valueUsd;
  p.unclaimedFeesUsd = unclaimedUsd;

  return (
    `${name} | Age: ${age} | Val: ${valStr} | Unclaimed: ${unclStr} | PnL: ${pnlStr} | ${status} | Range: ${range}\n` +
    `${link}`
  );
}

