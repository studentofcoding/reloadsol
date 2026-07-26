import {
  encodeFunctionData,
  maxUint256,
  type Address,
  type Hash,
  decodeEventLog,
} from 'viem';
import { executeRhWalletCalls, type RhTxCall } from '@/utils/dlmm/rh-send-calls';
import { CHAINS, type SupportedChainId, txUrl } from './config';
import { erc20Abi, npmAbi } from './abis';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients';
import { loadPool } from './pools';
import {
  assertInRange,
  assertOutOfRange,
  computeDualSidedRange,
  computeSingleSidedRange,
} from './ticks';
import { planZapFromToken0, planZapFromToken1 } from './zap';
import {
  clientKyberBuild,
  clientKyberRoute,
} from '@/utils/kyber-aggregator';
import {
  formatUnits,
  getTokenMeta,
  resolveDepositAmount,
  humanToFloat,
  type SizeMode,
} from './tokens';
import {
  getEffectiveDepositBalance,
  planWrapShortfall,
  weth9Abi,
  type WrapResult,
} from './wrap';
import { formatCompactRange, formatSpotPrice } from './prices';
import { getTokenPriceUsd, formatUsd } from './dexscreener';

export type MintParams = {
  chainId: SupportedChainId;
  poolAddress: Address | string;
  depositToken: Address;
  balancePercent: number;
  /** percent (default) or fixed deposit-token amount */
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  widthPercent: number;
  /** Near-edge buffer below/above market in % price (default 0 = tightest) */
  edgeBufferPercent?: number;
};

export type MintResult = {
  hash: Hash;
  tokenId: bigint;
  amount0: bigint;
  amount1: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  depositToken: Address;
  depositAmount: bigint;
  txLink: string;
  poolAddress: Address | string;
  fee: number;
  token0: Address;
  token1: Address;
  wrap?: WrapResult;
  protocol?: 'v3' | 'v4';
};

async function planApproveCall(
  chainId: SupportedChainId,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<RhTxCall | null> {
  const client = getPublicClient(chainId);
  const owner = getHotWalletAddress();
  const current = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  if (current >= amount) return null;
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, maxUint256],
    }),
  };
}

export type MintParamsWithProtocol = MintParams & {
  protocol?: 'v3' | 'v4';
  poolKey?: import('./v4').V4PoolKey;
  poolId?: import('viem').Hex;
};

const ZERO = '0x0000000000000000000000000000000000000000';

/** v4 poolId is bytes32 (66-char 0x…); v3 pool is 20-byte address (42-char). */
function looksLikeV4PoolId(id: string | undefined): boolean {
  return !!id && /^0x[a-fA-F0-9]{64}$/i.test(id);
}

/**
 * Match deposit to pool tokens, treating native (0x0) ↔ WETH/WBNB as equivalent.
 * Robinhood WETH often has symbol "ETH" — address match (or native pair) is what matters.
 */
function matchDepositSide(
  chainId: SupportedChainId,
  depositToken: Address,
  token0: Address,
  token1: Address,
): { isToken0: boolean; isToken1: boolean; deposit: Address } {
  const wrapped = CHAINS[chainId].wrapped.toLowerCase();
  const d = depositToken.toLowerCase();
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();

  const eq = (a: string, b: string) => {
    if (a === b) return true;
    // native ↔ wrapped
    if (a === ZERO && b === wrapped) return true;
    if (b === ZERO && a === wrapped) return true;
    return false;
  };

  const isToken0 = eq(d, t0);
  const isToken1 = eq(d, t1);

  return {
    isToken0,
    isToken1,
    deposit: depositToken,
  };
}

export async function mintSingleSided(params: MintParamsWithProtocol): Promise<MintResult> {
  // ── v4 path (native ETH/meow pools must never fall through to v3) ─────
  const forceV4 =
    params.protocol === 'v4' ||
    looksLikeV4PoolId(params.poolId) ||
    looksLikeV4PoolId(String(params.poolAddress));

  if (forceV4) {
    let poolKey = params.poolKey;
    let poolId = params.poolId ?? (looksLikeV4PoolId(String(params.poolAddress))
      ? (params.poolAddress as import('viem').Hex)
      : undefined);

    if ((!poolKey || !poolId) && poolId) {
      // Attempt recover PoolKey from POSM if session lost it
      try {
        const { resolveV4PoolKeyFromId } = await import('./v4');
        if (typeof resolveV4PoolKeyFromId === 'function') {
          poolKey = (await resolveV4PoolKeyFromId(params.chainId, poolId)) ?? poolKey;
        }
      } catch {
        /* optional helper */
      }
    }

    if (!poolKey || !poolId) {
      throw new Error(
        `v4 pool missing PoolKey/poolId (protocol=${params.protocol}). ` +
          `Paste the CA again and pick the [v4] pool — native ETH pairs need the v4 path.`,
      );
    }

    const { mintV4SingleSided } = await import('./v4');
    const r = await mintV4SingleSided({
      chainId: params.chainId,
      poolId,
      poolKey,
      depositToken: params.depositToken,
      balancePercent: params.balancePercent,
      sizeMode: params.sizeMode,
      fixedAmountHuman: params.fixedAmountHuman,
      widthPercent: params.widthPercent,
      edgeBufferPercent: params.edgeBufferPercent,
    });
    return {
      hash: r.hash,
      tokenId: r.tokenId,
      amount0: r.amount0,
      amount1: r.amount1,
      tickLower: r.tickLower,
      tickUpper: r.tickUpper,
      currentTick: r.currentTick,
      depositToken: r.depositToken,
      depositAmount: r.depositAmount,
      txLink: r.txLink,
      poolAddress: r.poolAddress,
      fee: r.fee,
      token0: r.token0,
      token1: r.token1,
      wrap: r.wrap,
      protocol: 'v4',
    };
  }

  const {
    chainId,
    poolAddress,
    balancePercent,
    sizeMode = 'percent',
    fixedAmountHuman = 0.1,
    widthPercent,
    edgeBufferPercent = 0,
  } = params;
  let { depositToken } = params;

  const v3PoolAddress = poolAddress as Address;

  // Fresh pool state — use raw token0/token1 from the contract (not meta cache)
  const client = getPublicClient(chainId);
  const { poolAbi } = await import('./abis');
  const [rawToken0, rawToken1] = await Promise.all([
    client.readContract({
      address: v3PoolAddress,
      abi: poolAbi,
      functionName: 'token0',
    }),
    client.readContract({
      address: v3PoolAddress,
      abi: poolAbi,
      functionName: 'token1',
    }),
  ]);
  const t0Addr = rawToken0 as Address;
  const t1Addr = rawToken1 as Address;

  let pool = await loadPool(chainId, v3PoolAddress);
  const wrapped = CHAINS[chainId].wrapped;

  // Align deposit to exact pool token addresses before any check
  {
    const d = depositToken.toLowerCase();
    const a0 = t0Addr.toLowerCase();
    const a1 = t1Addr.toLowerCase();
    const w = wrapped.toLowerCase();
    if (d !== a0 && d !== a1) {
      // Config WETH / eth-side symbol → map onto whichever pool token is ETH-side
      if (d === w || d === ZERO) {
        const m0 = pool.token0.symbol.toUpperCase();
        const m1 = pool.token1.symbol.toUpperCase();
        const eth0 =
          a0 === w ||
          a0 === ZERO ||
          m0 === 'ETH' ||
          m0 === 'WETH' ||
          m0 === 'BNB' ||
          m0 === 'WBNB';
        const eth1 =
          a1 === w ||
          a1 === ZERO ||
          m1 === 'ETH' ||
          m1 === 'WETH' ||
          m1 === 'BNB' ||
          m1 === 'WBNB';
        if (eth0 && !eth1) {
          depositToken = a0 === ZERO ? wrapped : t0Addr;
          console.warn(`[mint v3] deposit remapped → token0 ${depositToken}`);
        } else if (eth1 && !eth0) {
          depositToken = a1 === ZERO ? wrapped : t1Addr;
          console.warn(`[mint v3] deposit remapped → token1 ${depositToken}`);
        } else if (a0 === w) {
          depositToken = t0Addr;
        } else if (a1 === w) {
          depositToken = t1Addr;
        }
      }
    }
  }

  let matched = matchDepositSide(chainId, depositToken, t0Addr, t1Addr);
  let isToken0 = matched.isToken0;
  let isToken1 = matched.isToken1;
  depositToken = matched.deposit;

  if (!isToken0 && !isToken1) {
    // Last resort: pick eth-side pool token as deposit
    const m0 = pool.token0.symbol.toUpperCase();
    const m1 = pool.token1.symbol.toUpperCase();
    if (m0 === 'ETH' || m0 === 'WETH' || m0 === 'BNB' || m0 === 'WBNB') {
      depositToken = t0Addr;
      isToken0 = true;
      isToken1 = false;
    } else if (m1 === 'ETH' || m1 === 'WETH' || m1 === 'BNB' || m1 === 'WBNB') {
      depositToken = t1Addr;
      isToken0 = false;
      isToken1 = true;
    }
  }

  if (!isToken0 && !isToken1) {
    const depMeta = await getTokenMeta(chainId, depositToken).catch(() => null);
    const depSym = depMeta?.symbol ?? depositToken.slice(0, 10);
    throw new Error(
      `Deposit ${depSym} (${depositToken.slice(0, 10)}…) is not in pool ` +
        `${pool.token0.symbol}/${pool.token1.symbol} ` +
        `(${t0Addr.slice(0, 10)}…/${t1Addr.slice(0, 10)}…). ` +
        `Pool address ${v3PoolAddress.slice(0, 12)}… — re-pick the pool from the list.`,
    );
  }

  console.log(
    `[mint v3] deposit=${depositToken} isToken0=${isToken0} pool=${v3PoolAddress} ` +
      `t0=${t0Addr} t1=${t1Addr}`,
  );

  const eff = await getEffectiveDepositBalance(chainId, depositToken);
  if (eff.effective <= BigInt(0)) {
    throw new Error(
      eff.isWrapped
        ? 'Hot wallet has 0 WETH/WBNB and no native left to wrap (after gas reserve)'
        : 'Hot wallet balance is 0 for deposit token',
    );
  }

  const depMetaEarly = await getTokenMeta(chainId, depositToken);
  const depositAmount = resolveDepositAmount(eff.effective, {
    sizeMode,
    balancePercent,
    fixedAmountHuman,
    decimals: depMetaEarly.decimals,
    symbol: depMetaEarly.symbol,
  });

  const wrapAmount = await planWrapShortfall(chainId, depositToken, depositAmount);
  let wrap: WrapResult | undefined;
  if (wrapAmount > BigInt(0)) {
    wrap = { hash: '0x' as Hash, amount: wrapAmount }; // hash filled after batch
  }

  // Re-load tick (price may have moved while reading)
  pool = await loadPool(chainId, v3PoolAddress);

  const { tickLower, tickUpper, edgeBufferTicks, side } = computeSingleSidedRange({
    currentTick: pool.tick,
    tickSpacing: pool.tickSpacing,
    widthPercent,
    depositIsToken0: isToken0,
    edgeBufferPercent,
  });

  console.log(
    `[mint] tick=${pool.tick} spacing=${pool.tickSpacing} edgeBuf=${edgeBufferTicks} ` +
      `range=[${tickLower},${tickUpper}] side=${side} deposit=${isToken0 ? 'token0' : 'token1'} amt=${depositAmount}`,
  );

  // Final safety: refuse if range would not be single-sided
  assertOutOfRange({
    currentTick: pool.tick,
    tickLower,
    tickUpper,
    depositIsToken0: isToken0,
  });

  // Single-sided: only one amount; min=0 avoids false slippage reverts
  const amount0Desired = isToken0 ? depositAmount : BigInt(0);
  const amount1Desired = isToken1 ? depositAmount : BigInt(0);
  const amount0Min = BigInt(0);
  const amount1Min = BigInt(0);

  if (amount0Desired === BigInt(0) && amount1Desired === BigInt(0)) {
    throw new Error('Both desired amounts are 0');
  }

  const npm = CHAINS[chainId].npm;
  const approveCall = await planApproveCall(chainId, depositToken, npm, depositAmount);

  // Refresh tick once more right before submit (price may have moved)
  pool = await loadPool(chainId, v3PoolAddress);
  assertOutOfRange({
    currentTick: pool.tick,
    tickLower,
    tickUpper,
    depositIsToken0: isToken0,
  });

  // If price moved toward range, rebuild once with fresh tick
  let finalLower = tickLower;
  let finalUpper = tickUpper;
  try {
    assertOutOfRange({
      currentTick: pool.tick,
      tickLower: finalLower,
      tickUpper: finalUpper,
      depositIsToken0: isToken0,
    });
  } catch {
    const rebuilt = computeSingleSidedRange({
      currentTick: pool.tick,
      tickSpacing: pool.tickSpacing,
      widthPercent,
      depositIsToken0: isToken0,
      edgeBufferPercent,
    });
    finalLower = rebuilt.tickLower;
    finalUpper = rebuilt.tickUpper;
    console.log(`[mint] rebuilt range after price move → [${finalLower},${finalUpper}] tick=${pool.tick}`);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const recipient = getHotWalletAddress();
  const wallet = getWalletClient(chainId);

  const mintArgs = {
    token0: t0Addr,
    token1: t1Addr,
    fee: pool.fee,
    tickLower: finalLower,
    tickUpper: finalUpper,
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    recipient,
    deadline,
  } as const;

  const calls: RhTxCall[] = [];
  if (wrapAmount > BigInt(0)) {
    calls.push({
      to: CHAINS[chainId].wrapped,
      data: encodeFunctionData({ abi: weth9Abi, functionName: 'deposit' }),
      value: wrapAmount,
    });
  }
  if (approveCall) calls.push(approveCall);
  calls.push({
    to: npm,
    data: encodeFunctionData({
      abi: npmAbi,
      functionName: 'mint',
      args: [mintArgs],
    }),
    gas: BigInt('900000'),
  });

  // Simulate only when no prior batch legs (wrap/approve change state before mint)
  if (calls.length === 1) {
    try {
      await client.simulateContract({
        address: npm,
        abi: npmAbi,
        functionName: 'mint',
        args: [mintArgs],
        account: recipient,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[mint simulate failed]', msg);
      throw new Error(
        `Mint would revert (range below market, single-sided). ` +
          `tick=${pool.tick} range=[${finalLower},${finalUpper}] ` +
          `deposit=${isToken0 ? 'token0' : 'token1'}. ` +
          `Try a larger % or more balance. Underlying: ${msg.slice(0, 200)}`,
      );
    }
  }

  const { hash: batchHash } = await executeRhWalletCalls({
    publicClient: client,
    walletClient: wallet,
    account: recipient,
    calls,
  });
  const hash = batchHash as Hash;
  if (wrap) wrap = { hash, amount: wrapAmount };

  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Mint tx reverted on-chain: ${hash}`);
  }

  let tokenId = BigInt(0);
  let amount0 = amount0Desired;
  let amount1 = amount1Desired;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== npm.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: npmAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'IncreaseLiquidity') {
        const args = decoded.args as {
          tokenId: bigint;
          amount0: bigint;
          amount1: bigint;
        };
        tokenId = args.tokenId;
        amount0 = args.amount0;
        amount1 = args.amount1;
      }
    } catch {
      // skip
    }
  }

  if (tokenId === BigInt(0)) {
    const bal = await client.readContract({
      address: npm,
      abi: npmAbi,
      functionName: 'balanceOf',
      args: [recipient],
    });
    if (bal > BigInt(0)) {
      tokenId = await client.readContract({
        address: npm,
        abi: npmAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [recipient, bal - BigInt(1)],
      });
    }
  }

  return {
    hash,
    tokenId,
    amount0,
    amount1,
    tickLower: finalLower,
    tickUpper: finalUpper,
    currentTick: pool.tick,
    depositToken,
    depositAmount,
    txLink: txUrl(chainId, hash),
    poolAddress,
    fee: pool.fee,
    token0: pool.token0.address,
    token1: pool.token1.address,
    wrap,
  };
}

/**
 * Confirmation detail for mint: value deposited, range, current price.
 */
export async function describeMintPreview(params: {
  chainId: SupportedChainId;
  poolAddress: Address | string;
  depositToken: Address;
  balancePercent: number;
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  widthPercent: number;
  edgeBufferPercent?: number;
  protocol?: 'v3' | 'v4';
  poolKey?: import('./v4').V4PoolKey;
  poolId?: import('viem').Hex;
}): Promise<string> {
  if (params.protocol === 'v4' && params.poolKey && params.poolId) {
    const { describeV4MintPreview } = await import('./v4');
    return describeV4MintPreview({
      chainId: params.chainId,
      poolId: params.poolId,
      poolKey: params.poolKey,
      depositToken: params.depositToken,
      balancePercent: params.balancePercent,
      sizeMode: params.sizeMode,
      fixedAmountHuman: params.fixedAmountHuman,
      widthPercent: params.widthPercent,
      edgeBufferPercent: params.edgeBufferPercent,
    });
  }

  const pool = await loadPool(params.chainId, params.poolAddress as Address);
  const depMeta = await getTokenMeta(params.chainId, params.depositToken);
  const eff = await getEffectiveDepositBalance(params.chainId, params.depositToken);
  const amount = resolveDepositAmount(eff.effective, {
    sizeMode: params.sizeMode ?? 'percent',
    balancePercent: params.balancePercent,
    fixedAmountHuman: params.fixedAmountHuman ?? 0.1,
    decimals: depMeta.decimals,
    symbol: depMeta.symbol,
  });
  const amountHuman = humanToFloat(amount, depMeta.decimals);
  const px = (await getTokenPriceUsd(params.chainId, params.depositToken)) ?? 0;
  const valueUsd = amountHuman * px;
  const sizeLabel =
    (params.sizeMode ?? 'percent') === 'fixed'
      ? `${params.fixedAmountHuman ?? 0.1} fixed`
      : `${params.balancePercent}%`;

  const isToken0 = pool.token0.address.toLowerCase() === params.depositToken.toLowerCase();
  const { tickLower, tickUpper, side } = computeSingleSidedRange({
    currentTick: pool.tick,
    tickSpacing: pool.tickSpacing,
    widthPercent: params.widthPercent,
    depositIsToken0: isToken0,
    edgeBufferPercent: params.edgeBufferPercent ?? 0,
  });

  const range = formatCompactRange({
    chainId: params.chainId,
    token0: pool.token0.address,
    token1: pool.token1.address,
    decimals0: pool.token0.decimals,
    decimals1: pool.token1.decimals,
    symbol0: pool.token0.symbol,
    symbol1: pool.token1.symbol,
    tickLower,
    tickUpper,
    currentTick: pool.tick,
  });

  const currentPriceStr = formatSpotPrice({
    chainId: params.chainId,
    token0: pool.token0.address,
    token1: pool.token1.address,
    decimals0: pool.token0.decimals,
    decimals1: pool.token1.decimals,
    symbol0: pool.token0.symbol,
    symbol1: pool.token1.symbol,
    tick: pool.tick,
  });

  const sideNote = side === 'above' ? 'range ABOVE market' : 'range BELOW market';
  const wrapNote =
    eff.isWrapped && amount > eff.erc20
      ? `\nAuto-wrap: ${formatUnits(amount - eff.erc20, 18)} native → ${depMeta.symbol}`
      : '';

  return (
    `Value deposited: ${formatUnits(amount, depMeta.decimals)} ${depMeta.symbol}` +
    ` (${sizeLabel} · ${formatUsd(valueUsd)})\n` +
    `Range: ${range}\n` +
    `Current price: ${currentPriceStr}\n` +
    `Pool: ${pool.token0.symbol}/${pool.token1.symbol} ${(pool.fee / 10000).toFixed(2)}% · ${sideNote}` +
    wrapNote
  );
}

export type DualMintPreview = {
  text: string;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  amount0: bigint;
  amount1: bigint;
  amount0Human: number;
  amount1Human: number;
  symbol0: string;
  symbol1: string;
  depositToken: Address;
  depositAmount: bigint;
  depositSymbol: string;
  fee: number;
  priceImpactPct: number | null;
  swapAmountIn: bigint;
  swapDirection: '0to1' | '1to0' | 'none';
};

export type DualMintParams = {
  chainId: SupportedChainId;
  poolAddress: Address;
  depositToken: Address;
  balancePercent: number;
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  minPct: number;
  maxPct: number;
  fullRange?: boolean;
  slippageBps?: number;
};

/** Preview dual-sided zap split (Kyber quote for swap leg). */
export async function describeDualMintPreview(
  params: DualMintParams,
): Promise<DualMintPreview> {
  const pool = await loadPool(params.chainId, params.poolAddress);
  const { tickLower, tickUpper } = computeDualSidedRange({
    currentTick: pool.tick,
    tickSpacing: pool.tickSpacing,
    minPct: params.minPct,
    maxPct: params.maxPct,
    fullRange: params.fullRange,
  });
  assertInRange({
    currentTick: pool.tick,
    tickLower,
    tickUpper,
  });

  const depMeta = await getTokenMeta(params.chainId, params.depositToken);
  const eff = await getEffectiveDepositBalance(
    params.chainId,
    params.depositToken,
  );
  const depositAmount = resolveDepositAmount(eff.effective, {
    sizeMode: params.sizeMode ?? 'percent',
    balancePercent: params.balancePercent,
    fixedAmountHuman: params.fixedAmountHuman ?? 0.1,
    decimals: depMeta.decimals,
    symbol: depMeta.symbol,
  });

  const isToken0 =
    pool.token0.address.toLowerCase() === params.depositToken.toLowerCase() ||
    (params.depositToken.toLowerCase() === CHAINS[params.chainId].wrapped.toLowerCase() &&
      pool.token0.address.toLowerCase() === CHAINS[params.chainId].wrapped.toLowerCase());
  const isToken1 =
    pool.token1.address.toLowerCase() === params.depositToken.toLowerCase() ||
    (params.depositToken.toLowerCase() === CHAINS[params.chainId].wrapped.toLowerCase() &&
      pool.token1.address.toLowerCase() === CHAINS[params.chainId].wrapped.toLowerCase());

  if (!isToken0 && !isToken1) {
    throw new Error(
      'Dual zap currently requires deposit to be a pool token (WETH/USDG leg)',
    );
  }

  let amount0 = 0n;
  let amount1 = 0n;
  let swapAmountIn = 0n;
  let swapDirection: DualMintPreview['swapDirection'] = 'none';

  if (isToken0) {
    const plan = planZapFromToken0({
      depositAmount,
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower,
      tickUpper,
    });
    amount0 = plan.amount0;
    amount1 = plan.amount1;
    swapAmountIn = plan.swapToken0For1;
    swapDirection = swapAmountIn > 0n ? '0to1' : 'none';
  } else {
    const plan = planZapFromToken1({
      depositAmount,
      sqrtPriceX96: pool.sqrtPriceX96,
      tickLower,
      tickUpper,
    });
    amount0 = plan.amount0;
    amount1 = plan.amount1;
    swapAmountIn = plan.swapToken1For0;
    swapDirection = swapAmountIn > 0n ? '1to0' : 'none';
  }

  let priceImpactPct: number | null = null;
  if (swapAmountIn > 0n) {
    const tokenIn = isToken0 ? pool.token0.address : pool.token1.address;
    const tokenOut = isToken0 ? pool.token1.address : pool.token0.address;
    try {
      const route = await clientKyberRoute({
        tokenIn,
        tokenOut,
        amountIn: swapAmountIn.toString(),
      });
      const raw = route.routeSummary as { amountInUsd?: string; amountOutUsd?: string };
      const inUsd = Number(raw.amountInUsd ?? NaN);
      const outUsd = Number(raw.amountOutUsd ?? NaN);
      if (Number.isFinite(inUsd) && Number.isFinite(outUsd) && inUsd > 0) {
        priceImpactPct = ((outUsd - inUsd) / inUsd) * 100;
      }
    } catch {
      priceImpactPct = null;
    }
  }

  const range = formatCompactRange({
    chainId: params.chainId,
    token0: pool.token0.address,
    token1: pool.token1.address,
    decimals0: pool.token0.decimals,
    decimals1: pool.token1.decimals,
    symbol0: pool.token0.symbol,
    symbol1: pool.token1.symbol,
    tickLower,
    tickUpper,
    currentTick: pool.tick,
  });

  const a0h = humanToFloat(amount0, pool.token0.decimals);
  const a1h = humanToFloat(amount1, pool.token1.decimals);
  const impact =
    priceImpactPct != null ? ` · impact ${priceImpactPct.toFixed(2)}%` : '';

  const text =
    `Mode: dual-sided zap\n` +
    `Deposit: ${formatUnits(depositAmount, depMeta.decimals)} ${depMeta.symbol}\n` +
    `→ ${a0h.toPrecision(6)} ${pool.token0.symbol} + ${a1h.toPrecision(6)} ${pool.token1.symbol}${impact}\n` +
    `Range: ${range}\n` +
    `Pool: ${pool.token0.symbol}/${pool.token1.symbol} ${(pool.fee / 10000).toFixed(2)}%`;

  return {
    text,
    tickLower,
    tickUpper,
    currentTick: pool.tick,
    amount0,
    amount1,
    amount0Human: a0h,
    amount1Human: a1h,
    symbol0: pool.token0.symbol,
    symbol1: pool.token1.symbol,
    depositToken: params.depositToken,
    depositAmount,
    depositSymbol: depMeta.symbol,
    fee: pool.fee,
    priceImpactPct,
    swapAmountIn,
    swapDirection,
  };
}

/** Dual-sided: Kyber swap for missing leg, then NPM mint. v3 only. */
export async function mintDualSided(params: DualMintParams): Promise<MintResult> {
  const preview = await describeDualMintPreview(params);
  const pool = await loadPool(params.chainId, params.poolAddress);
  const client = getPublicClient(params.chainId);
  const wallet = getWalletClient(params.chainId);
  const recipient = getHotWalletAddress();
  const npm = CHAINS[params.chainId].npm;
  const slippage = params.slippageBps ?? 100;

  const wrapAmount = await planWrapShortfall(
    params.chainId,
    params.depositToken,
    preview.depositAmount,
  );

  const calls: RhTxCall[] = [];
  if (wrapAmount > 0n) {
    calls.push({
      to: CHAINS[params.chainId].wrapped,
      data: encodeFunctionData({ abi: weth9Abi, functionName: 'deposit' }),
      value: wrapAmount,
    });
  }

  if (preview.swapAmountIn > 0n && preview.swapDirection !== 'none') {
    const tokenIn =
      preview.swapDirection === '0to1'
        ? pool.token0.address
        : pool.token1.address;
    const tokenOut =
      preview.swapDirection === '0to1'
        ? pool.token1.address
        : pool.token0.address;
    const route = await clientKyberRoute({
      tokenIn,
      tokenOut,
      amountIn: preview.swapAmountIn.toString(),
    });
    const build = await clientKyberBuild({
      routeSummary: route.routeSummary,
      sender: recipient,
      recipient,
      slippageTolerance: slippage,
    });
    const approveSwap = await planApproveCall(
      params.chainId,
      tokenIn,
      build.routerAddress as Address,
      preview.swapAmountIn,
    );
    if (approveSwap) calls.push(approveSwap);
    calls.push({
      to: build.routerAddress as Address,
      data: build.data,
      value: build.valueWei,
    });
  }

  const approve0 = await planApproveCall(
    params.chainId,
    pool.token0.address,
    npm,
    preview.amount0,
  );
  const approve1 = await planApproveCall(
    params.chainId,
    pool.token1.address,
    npm,
    preview.amount1,
  );
  if (approve0) calls.push(approve0);
  if (approve1) calls.push(approve1);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const mintArgs = {
    token0: pool.token0.address,
    token1: pool.token1.address,
    fee: pool.fee,
    tickLower: preview.tickLower,
    tickUpper: preview.tickUpper,
    amount0Desired: preview.amount0,
    amount1Desired: preview.amount1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient,
    deadline,
  } as const;

  calls.push({
    to: npm,
    data: encodeFunctionData({
      abi: npmAbi,
      functionName: 'mint',
      args: [mintArgs],
    }),
    gas: 1_200_000n,
  });

  const { hash: batchHash } = await executeRhWalletCalls({
    publicClient: client,
    walletClient: wallet,
    account: recipient,
    calls,
  });
  const hash = batchHash as Hash;
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Dual mint tx reverted: ${hash}`);
  }

  let tokenId = 0n;
  let amount0 = preview.amount0;
  let amount1 = preview.amount1;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== npm.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: npmAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'IncreaseLiquidity') {
        const args = decoded.args as {
          tokenId: bigint;
          amount0: bigint;
          amount1: bigint;
        };
        tokenId = args.tokenId;
        amount0 = args.amount0;
        amount1 = args.amount1;
      }
    } catch {
      /* skip */
    }
  }

  return {
    hash,
    tokenId,
    amount0,
    amount1,
    tickLower: preview.tickLower,
    tickUpper: preview.tickUpper,
    currentTick: pool.tick,
    depositToken: params.depositToken,
    depositAmount: preview.depositAmount,
    txLink: txUrl(params.chainId, hash),
    poolAddress: params.poolAddress,
    fee: pool.fee,
    token0: pool.token0.address,
    token1: pool.token1.address,
    wrap:
      wrapAmount > 0n ? { hash, amount: wrapAmount } : undefined,
  };
}
