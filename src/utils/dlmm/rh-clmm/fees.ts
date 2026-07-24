/**
 * Unclaimed LP fees.
 *
 * Uniswap does NOT put accruing fees into positions().tokensOwed until a
 * decreaseLiquidity / burn "poke". Live unclaimed fees must be derived from
 * feeGrowthInside - feeGrowthInsideLast.
 */
import type { Address, Hex } from 'viem';
import { pad, toHex } from 'viem';
import { poolAbi, stateViewAbi } from './abis';
import { CHAINS, type SupportedChainId } from './config';
import { getPublicClient } from './clients';

const Q128 = BigInt(1) << BigInt(128);

/** fees = liquidity * (growthInside - growthLast) / 2^128  (handles uint256 wrap) */
export function feesFromGrowth(
  feeGrowthInsideX128: bigint,
  feeGrowthInsideLastX128: bigint,
  liquidity: bigint,
): bigint {
  if (liquidity === BigInt(0)) return BigInt(0);
  let delta = feeGrowthInsideX128 - feeGrowthInsideLastX128;
  if (delta < BigInt(0)) {
    // uint256 overflow wrap
    delta = (BigInt(1) << BigInt(256)) + delta;
  }
  return (liquidity * delta) / Q128;
}

/**
 * feeGrowthInside given global + outside values (Uniswap V3 Tick math).
 */
export function feeGrowthInside(
  feeGrowthGlobalX128: bigint,
  feeGrowthOutsideLowerX128: bigint,
  feeGrowthOutsideUpperX128: bigint,
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
): bigint {
  let feeGrowthBelow: bigint;
  if (tickCurrent >= tickLower) {
    feeGrowthBelow = feeGrowthOutsideLowerX128;
  } else {
    feeGrowthBelow = feeGrowthGlobalX128 - feeGrowthOutsideLowerX128;
  }

  let feeGrowthAbove: bigint;
  if (tickCurrent < tickUpper) {
    feeGrowthAbove = feeGrowthOutsideUpperX128;
  } else {
    feeGrowthAbove = feeGrowthGlobalX128 - feeGrowthOutsideUpperX128;
  }

  return feeGrowthGlobalX128 - feeGrowthBelow - feeGrowthAbove;
}

/**
 * Live unclaimed fees for a v3 NPM position (includes already-accounted tokensOwed).
 */
export async function computeV3UnclaimedFees(params: {
  chainId: SupportedChainId;
  poolAddress: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  currentTick: number;
}): Promise<{ fees0: bigint; fees1: bigint }> {
  const {
    chainId,
    poolAddress,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    tokensOwed0,
    tokensOwed1,
    currentTick,
  } = params;

  if (liquidity === BigInt(0)) {
    return { fees0: tokensOwed0, fees1: tokensOwed1 };
  }

  const client = getPublicClient(chainId);
  try {
    const [g0, g1, tickL, tickU] = await Promise.all([
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'feeGrowthGlobal0X128',
      }),
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'feeGrowthGlobal1X128',
      }),
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'ticks',
        args: [tickLower],
      }),
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: 'ticks',
        args: [tickUpper],
      }),
    ]);

    const outside0L = tickL[2] as bigint;
    const outside1L = tickL[3] as bigint;
    const outside0U = tickU[2] as bigint;
    const outside1U = tickU[3] as bigint;

    const inside0 = feeGrowthInside(
      g0 as bigint,
      outside0L,
      outside0U,
      currentTick,
      tickLower,
      tickUpper,
    );
    const inside1 = feeGrowthInside(
      g1 as bigint,
      outside1L,
      outside1U,
      currentTick,
      tickLower,
      tickUpper,
    );

    const accrued0 = feesFromGrowth(inside0, feeGrowthInside0LastX128, liquidity);
    const accrued1 = feesFromGrowth(inside1, feeGrowthInside1LastX128, liquidity);

    return {
      fees0: tokensOwed0 + accrued0,
      fees1: tokensOwed1 + accrued1,
    };
  } catch (e) {
    console.warn('[fees v3]', e instanceof Error ? e.message : e);
    return { fees0: tokensOwed0, fees1: tokensOwed1 };
  }
}

/**
 * Live unclaimed fees for a v4 PositionManager NFT.
 * Position is owned by POSM with salt = bytes32(tokenId).
 */
export async function computeV4UnclaimedFees(params: {
  chainId: SupportedChainId;
  poolId: Hex;
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): Promise<{ fees0: bigint; fees1: bigint }> {
  const { chainId, poolId, tokenId, tickLower, tickUpper, liquidity } = params;
  if (liquidity === BigInt(0)) return { fees0: BigInt(0), fees1: BigInt(0) };

  const client = getPublicClient(chainId);
  const stateView = CHAINS[chainId].v4StateView;
  const posm = CHAINS[chainId].v4PositionManager;
  const salt = pad(toHex(tokenId), { size: 32 });

  try {
    const [inside, posInfo] = await Promise.all([
      client.readContract({
        address: stateView,
        abi: stateViewAbi,
        functionName: 'getFeeGrowthInside',
        args: [poolId, tickLower, tickUpper],
      }),
      client.readContract({
        address: stateView,
        abi: stateViewAbi,
        functionName: 'getPositionInfo',
        args: [poolId, posm, tickLower, tickUpper, salt],
      }),
    ]);

    const feeGrowthInside0 = inside[0] as bigint;
    const feeGrowthInside1 = inside[1] as bigint;
    // posInfo: liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128
    const last0 = posInfo[1] as bigint;
    const last1 = posInfo[2] as bigint;
    const liq = (posInfo[0] as bigint) || liquidity;

    return {
      fees0: feesFromGrowth(feeGrowthInside0, last0, liq),
      fees1: feesFromGrowth(feeGrowthInside1, last1, liq),
    };
  } catch (e) {
    console.warn('[fees v4]', tokenId.toString(), e instanceof Error ? e.message : e);
    return { fees0: BigInt(0), fees1: BigInt(0) };
  }
}
