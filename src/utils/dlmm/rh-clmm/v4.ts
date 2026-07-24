/**
 * Uniswap v4 helpers: PoolKey, pool load, mint, list, close.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  maxUint256,
  type Address,
  type Hash,
  type Hex,
  decodeEventLog,
} from 'viem';
import { executeRhWalletCalls, type RhTxCall } from '@/utils/dlmm/rh-send-calls';
import {
  CHAINS,
  PERMIT2,
  type SupportedChainId,
  txUrl,
} from './config';
import {
  erc20Abi,
  permit2Abi,
  stateViewAbi,
  v4PositionManagerAbi,
} from './abis';
import { getHotWalletAddress, getPublicClient, getWalletClient } from './clients';
import {
  Token,
  Ether,
  V4Pool,
  V4Position,
  nearestUsableTick,
  TickMath,
} from './uniswap';
import {
  fetchUniswapV4PoolsForToken,
  type DexPair,
  getTokenPriceUsd,
  formatUsd,
} from './dexscreener';
import { fetchTopV4Pools } from './uniswapExplore';
import {
  getTokenMeta,
  getTokenBalance,
  formatUnits,
  humanToFloat,
  resolveDepositAmount,
  type SizeMode,
} from './tokens';
import {
  getEffectiveDepositBalance,
  planWrapShortfall,
  weth9Abi,
  type WrapResult,
} from './wrap';
import { assertOutOfRange, computeSingleSidedRange } from './ticks';
import { formatCompactRange, formatSpotPrice } from './prices';
import type { OnChainPosition } from './positions';
import {
  formatAge,
  formatEthVal,
  uniswapPositionUrl,
} from './prices';

export type V4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type V4PoolInfo = {
  protocol: 'v4';
  poolId: Hex;
  poolKey: V4PoolKey;
  token0: Awaited<ReturnType<typeof getTokenMeta>>;
  token1: Awaited<ReturnType<typeof getTokenMeta>>;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  tvlUsd?: number;
  dexUrl?: string;
};

export type ListedV4Pool = {
  protocol: 'v4';
  pair: DexPair;
  /** PoolId (bytes32 hex) — used as identifier in UI/session */
  poolAddress: string;
  poolId: Hex;
  poolKey: V4PoolKey;
  fee: number;
  tvlUsd: number;
  token0: Address;
  token1: Address;
  otherSymbol: string;
  otherAddress: Address;
  label: string;
};

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const HOOKS_ZERO = ZERO;

/** Standard fee → spacing (vanilla). Custom fees need POSM.poolKeys or spacing brute-force. */
const FEE_SPACING: [number, number][] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

/** Tick spacings to try when fee is known but POSM cache empty (Robinhood custom pools use odd values e.g. 644) */
const SPACING_CANDIDATES = [
  1, 10, 50, 60, 100, 200, 250, 300, 400, 500, 600, 644, 800, 1000, 2000,
];

/** Truncate full poolId (bytes32) to bytes25 for PositionManager.poolKeys */
export function poolIdToBytes25(poolId: string): Hex {
  const hex = poolId.startsWith('0x') ? poolId.slice(2) : poolId;
  if (hex.length < 50) throw new Error(`Invalid poolId: ${poolId}`);
  return `0x${hex.slice(0, 50)}` as Hex;
}

export function computePoolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/**
 * Recover PoolKey from PositionManager.poolKeys cache only (no token pair guess).
 * Works after any POSM interaction / when session lost poolKey but poolId is known.
 */
export async function resolveV4PoolKeyFromId(
  chainId: SupportedChainId,
  poolId: Hex,
): Promise<V4PoolKey | null> {
  const client = getPublicClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  try {
    const key = await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'poolKeys',
      args: [poolIdToBytes25(poolId)],
    });
    const tickSpacing = Number(key[3]);
    if (tickSpacing === 0) return null;
    return {
      currency0: key[0] as Address,
      currency1: key[1] as Address,
      fee: Number(key[2]),
      tickSpacing,
      hooks: key[4] as Address,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve full PoolKey for a known poolId.
 * Prefer PositionManager.poolKeys (works for any fee/spacing once a position was minted).
 * Fallback: match poolId by trying fee+spacing candidates with token currencies.
 */
export async function resolveV4PoolKey(
  chainId: SupportedChainId,
  poolId: Hex,
  tokenA: Address,
  tokenB: Address,
  knownFee?: number,
): Promise<V4PoolKey | null> {
  const fromCache = await resolveV4PoolKeyFromId(chainId, poolId);
  if (fromCache) return fromCache;

  // Currency pair variants: ERC20 as given, and native (0x0) if one side is wrapped
  const wrapped = CHAINS[chainId].wrapped.toLowerCase();
  const pairVariants: [Address, Address][] = [sortCurrencies(tokenA, tokenB)];
  for (const [a, b] of [[tokenA, tokenB], [tokenB, tokenA]] as [Address, Address][]) {
    if (a.toLowerCase() === wrapped) {
      pairVariants.push(sortCurrencies(ZERO, b));
    }
  }

  const feesToTry =
    knownFee != null && knownFee > 0
      ? [knownFee, ...FEE_SPACING.map(([f]) => f)]
      : FEE_SPACING.map(([f]) => f);
  const uniqueFees = [...new Set(feesToTry)];

  for (const [c0, c1] of pairVariants) {
    for (const fee of uniqueFees) {
      const spacings =
        knownFee != null && fee === knownFee
          ? SPACING_CANDIDATES
          : FEE_SPACING.filter(([f]) => f === fee).map(([, s]) => s).concat(SPACING_CANDIDATES);
      const uniqueSp = [...new Set(spacings)];
      for (const spacing of uniqueSp) {
        const candidate: V4PoolKey = {
          currency0: c0,
          currency1: c1,
          fee,
          tickSpacing: spacing,
          hooks: HOOKS_ZERO,
        };
        const id = computePoolId(candidate);
        if (id.toLowerCase() === poolId.toLowerCase()) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function syntheticDexPair(params: {
  poolId: string;
  chainSlug: string;
  symbol0: string;
  symbol1: string;
  addr0: string;
  addr1: string;
  tvlUsd: number;
}): DexPair {
  return {
    chainId: params.chainSlug,
    dexId: 'uniswap',
    pairAddress: params.poolId,
    labels: ['v4'],
    baseToken: {
      address: params.addr0,
      symbol: params.symbol0,
      name: params.symbol0,
    },
    quoteToken: {
      address: params.addr1,
      symbol: params.symbol1,
      name: params.symbol1,
    },
    liquidity: { usd: params.tvlUsd },
  };
}

export async function listV4PoolsForToken(
  chainId: SupportedChainId,
  tokenCa: Address,
): Promise<ListedV4Pool[]> {
  const out: ListedV4Pool[] = [];
  const ca = tokenCa.toLowerCase();
  const wrapped = CHAINS[chainId].wrapped;
  const slug = CHAINS[chainId].dexscreenerSlug;

  // 1) Primary: Uniswap explore GraphQL (same source as app.uniswap.org)
  try {
    const explore = await fetchTopV4Pools(chainId, tokenCa);
    console.log(`[v4] explore found ${explore.length} pools for ${tokenCa.slice(0, 10)}…`);
    for (const ep of explore) {
      try {
        const tokenA = (ep.currency0 ?? ZERO) as Address;
        const tokenB = (ep.currency1 ?? ZERO) as Address;
        // For resolve: pass actual ERC20 when native is null
        const resolveA =
          ep.currency0 ??
          (ep.symbol0 === 'ETH' || ep.symbol0 === 'BNB' ? wrapped : ZERO);
        const resolveB =
          ep.currency1 ??
          (ep.symbol1 === 'ETH' || ep.symbol1 === 'BNB' ? wrapped : ZERO);

        const poolKey = await resolveV4PoolKey(
          chainId,
          ep.poolId,
          resolveA,
          resolveB,
          ep.fee,
        );
        if (!poolKey) {
          console.warn('[v4] could not resolve PoolKey', ep.poolId.slice(0, 18), 'fee', ep.fee);
          continue;
        }

        const client = getPublicClient(chainId);
        const slot0 = await client.readContract({
          address: CHAINS[chainId].v4StateView,
          abi: stateViewAbi,
          functionName: 'getSlot0',
          args: [ep.poolId],
        });
        if ((slot0[0] as bigint) === BigInt(0)) continue;

        // "other" side relative to pasted CA
        const c0 = poolKey.currency0.toLowerCase();
        const c1 = poolKey.currency1.toLowerCase();
        const caIs0 =
          c0 === ca ||
          (c0 === ZERO && (wrapped.toLowerCase() === ca || resolveA.toLowerCase() === ca));
        // better: check if token is CA
        let otherAddress: Address;
        let otherSymbol: string;
        if (c0 === ca || (ep.currency0 && ep.currency0.toLowerCase() === ca)) {
          otherAddress = poolKey.currency1.toLowerCase() === ZERO ? wrapped : poolKey.currency1;
          otherSymbol =
            poolKey.currency1.toLowerCase() === ZERO
              ? CHAINS[chainId].wrappedSymbol
              : ep.symbol1;
        } else if (c1 === ca || (ep.currency1 && ep.currency1.toLowerCase() === ca)) {
          otherAddress = poolKey.currency0.toLowerCase() === ZERO ? wrapped : poolKey.currency0;
          otherSymbol =
            poolKey.currency0.toLowerCase() === ZERO
              ? CHAINS[chainId].wrappedSymbol
              : ep.symbol0;
        } else if (c0 === ZERO || c1 === ZERO) {
          // native pool: other is WETH side if CA is the meme
          otherAddress = wrapped;
          otherSymbol = CHAINS[chainId].wrappedSymbol;
        } else {
          otherAddress = poolKey.currency0.toLowerCase() === ca ? poolKey.currency1 : poolKey.currency0;
          otherSymbol = otherAddress.toLowerCase() === c0 ? ep.symbol0 : ep.symbol1;
        }

        // Prefer human symbols for native
        if (otherAddress.toLowerCase() === wrapped.toLowerCase()) {
          otherSymbol = CHAINS[chainId].wrappedSymbol;
        }
        if (c0 === ZERO && otherAddress.toLowerCase() === wrapped.toLowerCase()) {
          otherSymbol = CHAINS[chainId].nativeSymbol === 'ETH' ? 'WETH' : CHAINS[chainId].wrappedSymbol;
        }

        const feeLabel = `${(poolKey.fee / 10000).toFixed(2)}%`;
        const tvlUsd = ep.tvlUsd;
        const pair = syntheticDexPair({
          poolId: ep.poolId,
          chainSlug: slug,
          symbol0: ep.symbol0,
          symbol1: ep.symbol1,
          addr0: (ep.currency0 ?? ZERO) as string,
          addr1: (ep.currency1 ?? ZERO) as string,
          tvlUsd,
        });

        void tokenA;
        void tokenB;
        void caIs0;

        out.push({
          protocol: 'v4',
          pair,
          poolAddress: ep.poolId,
          poolId: ep.poolId,
          poolKey,
          fee: poolKey.fee,
          tvlUsd,
          token0: poolKey.currency0,
          token1: poolKey.currency1,
          otherSymbol,
          otherAddress,
          label: `v4 · ${otherSymbol} · fee ${feeLabel} · TVL $${tvlUsd.toFixed(0)}`,
        });
      } catch (e) {
        console.warn(
          '[v4 explore skip]',
          ep.poolId.slice(0, 18),
          e instanceof Error ? e.message : e,
        );
      }
    }
  } catch (e) {
    console.warn('[v4] explore failed', e instanceof Error ? e.message : e);
  }

  // 2) Secondary: DexScreener (often empty for v4 on Robinhood)
  try {
    const pairs = await fetchUniswapV4PoolsForToken(chainId, tokenCa);
    for (const pair of pairs) {
      const poolId = (pair.pairAddress.startsWith('0x')
        ? pair.pairAddress
        : `0x${pair.pairAddress}`) as Hex;
      if (poolId.length !== 66) continue;
      if (out.some((p) => p.poolId.toLowerCase() === poolId.toLowerCase())) continue;

      const base = pair.baseToken.address as Address;
      const quote = pair.quoteToken.address as Address;
      if (base.toLowerCase() !== ca && quote.toLowerCase() !== ca) continue;

      try {
        const poolKey = await resolveV4PoolKey(chainId, poolId, base, quote);
        if (!poolKey) continue;

        const client = getPublicClient(chainId);
        const slot0 = await client.readContract({
          address: CHAINS[chainId].v4StateView,
          abi: stateViewAbi,
          functionName: 'getSlot0',
          args: [poolId],
        });
        if ((slot0[0] as bigint) === BigInt(0)) continue;

        let otherAddress =
          poolKey.currency0.toLowerCase() === ca
            ? poolKey.currency1
            : poolKey.currency0;
        if (otherAddress.toLowerCase() === ZERO) otherAddress = wrapped;

        let otherSymbol = pair.baseToken.symbol;
        if (pair.quoteToken.address.toLowerCase() === otherAddress.toLowerCase()) {
          otherSymbol = pair.quoteToken.symbol;
        } else if (pair.baseToken.address.toLowerCase() === otherAddress.toLowerCase()) {
          otherSymbol = pair.baseToken.symbol;
        }

        const tvlUsd = pair.liquidity?.usd ?? 0;
        const feeLabel = `${(poolKey.fee / 10000).toFixed(2)}%`;
        out.push({
          protocol: 'v4',
          pair,
          poolAddress: poolId,
          poolId,
          poolKey,
          fee: poolKey.fee,
          tvlUsd,
          token0: poolKey.currency0,
          token1: poolKey.currency1,
          otherSymbol,
          otherAddress,
          label: `v4 · ${otherSymbol} · fee ${feeLabel} · TVL $${tvlUsd.toFixed(0)}`,
        });
      } catch (e) {
        console.warn('[v4 ds skip]', poolId.slice(0, 18), e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('[v4] dexscreener failed', e instanceof Error ? e.message : e);
  }

  const seen = new Set<string>();
  const unique = out.filter((p) => {
    const k = p.poolId.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return unique;
}

export async function loadV4Pool(
  chainId: SupportedChainId,
  poolIdOrKey: Hex | V4PoolKey,
): Promise<V4PoolInfo> {
  const client = getPublicClient(chainId);
  let poolKey: V4PoolKey;
  let poolId: Hex;

  if (typeof poolIdOrKey === 'string') {
    poolId = poolIdOrKey as Hex;
    // try poolKeys first
    try {
      const key = await client.readContract({
        address: CHAINS[chainId].v4PositionManager,
        abi: v4PositionManagerAbi,
        functionName: 'poolKeys',
        args: [poolIdToBytes25(poolId)],
      });
      if (Number(key[3]) !== 0) {
        poolKey = {
          currency0: key[0] as Address,
          currency1: key[1] as Address,
          fee: Number(key[2]),
          tickSpacing: Number(key[3]),
          hooks: key[4] as Address,
        };
      } else {
        throw new Error('empty');
      }
    } catch {
      throw new Error(
        `Cannot resolve v4 PoolKey for ${poolId}. Mint once via PositionManager or ensure pool is known.`,
      );
    }
  } else {
    poolKey = poolIdOrKey;
    poolId = computePoolId(poolKey);
  }

  const [slot0, liquidity] = await Promise.all([
    client.readContract({
      address: CHAINS[chainId].v4StateView,
      abi: stateViewAbi,
      functionName: 'getSlot0',
      args: [poolId],
    }),
    client.readContract({
      address: CHAINS[chainId].v4StateView,
      abi: stateViewAbi,
      functionName: 'getLiquidity',
      args: [poolId],
    }),
  ]);

  const addr0 =
    poolKey.currency0.toLowerCase() === ZERO
      ? CHAINS[chainId].wrapped
      : poolKey.currency0;
  const addr1 =
    poolKey.currency1.toLowerCase() === ZERO
      ? CHAINS[chainId].wrapped
      : poolKey.currency1;

  const [token0, token1] = await Promise.all([
    getTokenMeta(chainId, addr0),
    getTokenMeta(chainId, addr1),
  ]);
  // keep native symbol if currency is zero
  if (poolKey.currency0.toLowerCase() === ZERO) {
    token0.symbol = CHAINS[chainId].nativeSymbol;
    token0.address = ZERO;
  }
  if (poolKey.currency1.toLowerCase() === ZERO) {
    token1.symbol = CHAINS[chainId].nativeSymbol;
    token1.address = ZERO;
  }

  return {
    protocol: 'v4',
    poolId,
    poolKey,
    token0,
    token1,
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hooks: poolKey.hooks,
    sqrtPriceX96: slot0[0] as bigint,
    tick: Number(slot0[1]),
    liquidity: liquidity as bigint,
  };
}

// ── Permit2 ──────────────────────────────────────────────────────────

/** Build ERC20→Permit2 and Permit2→POSM approve calls (no writes). */
async function planPermit2Calls(
  chainId: SupportedChainId,
  token: Address,
  amount: bigint,
): Promise<RhTxCall[]> {
  if (token.toLowerCase() === ZERO) return [];

  const client = getPublicClient(chainId);
  const owner = getHotWalletAddress();
  const posm = CHAINS[chainId].v4PositionManager;
  const calls: RhTxCall[] = [];

  const ercAllowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, PERMIT2],
  });
  if (ercAllowance < amount) {
    calls.push({
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [PERMIT2, maxUint256],
      }),
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const [allowedAmt, expiration] = await client.readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [owner, token, posm],
  });
  const need =
    amount > (BigInt(1) << BigInt(160)) - BigInt(1)
      ? (BigInt(1) << BigInt(160)) - BigInt(1)
      : amount;
  if (allowedAmt < need || Number(expiration) <= now + 60) {
    const max160 = (BigInt(1) << BigInt(160)) - BigInt(1);
    const exp = (BigInt(1) << BigInt(48)) - BigInt(1);
    calls.push({
      to: PERMIT2,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: 'approve',
        args: [token, posm, max160, Number(exp)],
      }),
    });
  }
  return calls;
}

// ── Actions encoding ─────────────────────────────────────────────────

const Actions = {
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  SWEEP: 0x14,
} as const;

function encodeMintUnlockData(params: {
  poolKey: V4PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  recipient: Address;
  hookData?: Hex;
  useNative?: boolean;
}): Hex {
  const hookData = params.hookData ?? '0x';
  const actions = params.useNative
    ? encodePacked(
        ['uint8', 'uint8', 'uint8'],
        [Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP],
      )
    : encodePacked(['uint8', 'uint8'], [Actions.MINT_POSITION, Actions.SETTLE_PAIR]);

  const mintParam = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [
      {
        currency0: params.poolKey.currency0,
        currency1: params.poolKey.currency1,
        fee: params.poolKey.fee,
        tickSpacing: params.poolKey.tickSpacing,
        hooks: params.poolKey.hooks,
      },
      params.tickLower,
      params.tickUpper,
      params.liquidity,
      params.amount0Max,
      params.amount1Max,
      params.recipient,
      hookData,
    ],
  );

  const settleParam = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [params.poolKey.currency0, params.poolKey.currency1],
  );

  const paramList: Hex[] = [mintParam, settleParam];
  if (params.useNative) {
    paramList.push(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [ZERO, params.recipient],
      ),
    );
  }

  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, paramList],
  );
}

function encodeBurnUnlockData(params: {
  tokenId: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  hookData?: Hex;
}): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8'],
    [Actions.BURN_POSITION, Actions.TAKE_PAIR],
  );
  const burnParam = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [params.tokenId, params.amount0Min, params.amount1Min, params.hookData ?? '0x'],
  );
  const takeParam = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [params.currency0, params.currency1, params.recipient],
  );
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [burnParam, takeParam]],
  );
}

/** DECREASE full liquidity + TAKE_PAIR (keeps NFT; more reliable than BURN on some pools) */
function encodeDecreaseTakeUnlockData(params: {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  hookData?: Hex;
}): Hex {
  const actions = encodePacked(
    ['uint8', 'uint8'],
    [Actions.DECREASE_LIQUIDITY, Actions.TAKE_PAIR],
  );
  const decParam = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'bytes' },
    ],
    [
      params.tokenId,
      params.liquidity,
      params.amount0Min,
      params.amount1Min,
      params.hookData ?? '0x',
    ],
  );
  const takeParam = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [params.currency0, params.currency1, params.recipient],
  );
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [decParam, takeParam]],
  );
}

/** Collect fees only: decrease 0 + take pair */
function encodeCollectFeesUnlockData(params: {
  tokenId: bigint;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  hookData?: Hex;
}): Hex {
  return encodeDecreaseTakeUnlockData({
    tokenId: params.tokenId,
    liquidity: BigInt(0),
    amount0Min: BigInt(0),
    amount1Min: BigInt(0),
    currency0: params.currency0,
    currency1: params.currency1,
    recipient: params.recipient,
    hookData: params.hookData,
  });
}

// ── Mint ─────────────────────────────────────────────────────────────

export type V4MintParams = {
  chainId: SupportedChainId;
  poolId: Hex;
  poolKey: V4PoolKey;
  depositToken: Address;
  balancePercent: number;
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  widthPercent: number;
  edgeBufferPercent?: number;
};

export type V4MintResult = {
  protocol: 'v4';
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
  poolAddress: string;
  poolId: Hex;
  fee: number;
  token0: Address;
  token1: Address;
  wrap?: WrapResult;
};

function currencyIsDeposit(currency: Address, deposit: Address, wrapped: Address): boolean {
  const c = currency.toLowerCase();
  const d = deposit.toLowerCase();
  if (c === d) return true;
  // native ↔ wrapped for deposit matching
  if (c === ZERO && d === wrapped.toLowerCase()) return true;
  if (d === ZERO && c === wrapped.toLowerCase()) return true;
  return false;
}

export async function mintV4SingleSided(params: V4MintParams): Promise<V4MintResult> {
  const {
    chainId,
    poolId,
    poolKey,
    depositToken,
    balancePercent,
    sizeMode = 'percent',
    fixedAmountHuman = 0.1,
    widthPercent,
    edgeBufferPercent = 0,
  } = params;

  let pool = await loadV4Pool(chainId, poolKey);
  const wrapped = CHAINS[chainId].wrapped;
  const depositLower = depositToken.toLowerCase();

  const isToken0 = currencyIsDeposit(poolKey.currency0, depositToken, wrapped);
  const isToken1 = currencyIsDeposit(poolKey.currency1, depositToken, wrapped);
  if (!isToken0 && !isToken1) {
    throw new Error('Deposit token is not in the selected v4 pool');
  }

  // Prefer ERC20 wrapped over native for settlement simplicity unless currency is native
  const depositIsNativeCurrency =
    (isToken0 && poolKey.currency0.toLowerCase() === ZERO) ||
    (isToken1 && poolKey.currency1.toLowerCase() === ZERO);

  // Always fund via WETH+native effective balance; native pools spend msg.value
  const effToken = wrapped;
  const useWrappedErc20 = !depositIsNativeCurrency;
  const balToken = useWrappedErc20
    ? depositToken.toLowerCase() === wrapped.toLowerCase()
      ? wrapped
      : depositToken
    : wrapped;

  const eff = await getEffectiveDepositBalance(
    chainId,
    // WETH-side (incl. native) uses effective wrap balance; other ERC20 = raw balance
    balToken.toLowerCase() === wrapped.toLowerCase() ? wrapped : balToken,
  );
  if (eff.effective <= BigInt(0)) {
    throw new Error(
      balToken.toLowerCase() === wrapped.toLowerCase()
        ? 'Hot wallet has 0 WETH/WBNB and no native left to wrap (after gas reserve)'
        : 'Hot wallet balance is 0 for deposit token',
    );
  }

  const depMetaEarly = await getTokenMeta(
    chainId,
    balToken.toLowerCase() === wrapped.toLowerCase() ? wrapped : balToken,
  );
  const depositAmount = resolveDepositAmount(eff.effective, {
    sizeMode,
    balancePercent,
    fixedAmountHuman,
    decimals: depMetaEarly.decimals,
    symbol: depMetaEarly.symbol,
  });

  const preCalls: RhTxCall[] = [];
  let wrap: WrapResult | undefined;
  if (depositIsNativeCurrency) {
    // Need native ETH as msg.value — plan unwrap WETH if short on native
    const { getNativeBalance } = await import('./wrap');
    const nativeBal = await getNativeBalance(chainId);
    if (nativeBal < depositAmount) {
      const need = depositAmount - nativeBal;
      const wethBal = await getTokenBalance(chainId, wrapped);
      if (wethBal < need) {
        throw new Error(
          `Need ${formatUnits(depositAmount, 18)} native for this v4 ETH pool; ` +
            `have native ${formatUnits(nativeBal, 18)} + WETH ${formatUnits(wethBal, 18)}`,
        );
      }
      preCalls.push({
        to: wrapped,
        data: encodeFunctionData({
          abi: weth9Abi,
          functionName: 'withdraw',
          args: [need],
        }),
      });
      wrap = { hash: '0x' as Hash, amount: need };
      console.log(`[v4 mint] plan unwrap ${need} WETH → native for ETH pool`);
    }
  } else if (balToken.toLowerCase() === wrapped.toLowerCase()) {
    const wrapAmount = await planWrapShortfall(chainId, wrapped, depositAmount);
    if (wrapAmount > BigInt(0)) {
      preCalls.push({
        to: wrapped,
        data: encodeFunctionData({ abi: weth9Abi, functionName: 'deposit' }),
        value: wrapAmount,
      });
      wrap = { hash: '0x' as Hash, amount: wrapAmount };
    }
  }

  pool = await loadV4Pool(chainId, poolKey);

  const { tickLower, tickUpper, edgeBufferTicks, side } = computeSingleSidedRange({
    currentTick: pool.tick,
    tickSpacing: pool.tickSpacing,
    widthPercent,
    depositIsToken0: isToken0,
    edgeBufferPercent,
  });

  console.log(
    `[v4 mint] tick=${pool.tick} spacing=${pool.tickSpacing} edgeBuf=${edgeBufferTicks} ` +
      `range=[${tickLower},${tickUpper}] side=${side} deposit=${isToken0 ? 'token0' : 'token1'} amt=${depositAmount}`,
  );

  assertOutOfRange({
    currentTick: pool.tick,
    tickLower,
    tickUpper,
    depositIsToken0: isToken0,
  });

  // Build SDK currencies (native = Ether so poolKey order matches address-zero)
  const c0 =
    poolKey.currency0.toLowerCase() === ZERO
      ? Ether.onChain(chainId)
      : new Token(chainId, poolKey.currency0, pool.token0.decimals, pool.token0.symbol);
  const c1 =
    poolKey.currency1.toLowerCase() === ZERO
      ? Ether.onChain(chainId)
      : new Token(chainId, poolKey.currency1, pool.token1.decimals, pool.token1.symbol);

  const v4Pool = new V4Pool(
    c0,
    c1,
    pool.fee,
    pool.tickSpacing,
    poolKey.hooks,
    pool.sqrtPriceX96.toString(),
    pool.liquidity.toString(),
    pool.tick,
  );

  const amount0Desired = isToken0 ? depositAmount : BigInt(0);
  const amount1Desired = isToken1 ? depositAmount : BigInt(0);

  const position = V4Position.fromAmounts({
    pool: v4Pool,
    tickLower,
    tickUpper,
    amount0: amount0Desired.toString(),
    amount1: amount1Desired.toString(),
    useFullPrecision: true,
  });

  const liquidity = BigInt(position.liquidity.toString());
  if (liquidity === BigInt(0)) {
    throw new Error('Computed liquidity is 0 — check range / amount');
  }

  // Max amounts: deposit + small buffer (single-sided other side 0)
  const amount0Max = isToken0 ? depositAmount : BigInt(0);
  const amount1Max = isToken1 ? depositAmount : BigInt(0);
  // uint128 max check
  const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
  if (amount0Max > U128_MAX || amount1Max > U128_MAX) {
    throw new Error('Amount exceeds uint128');
  }

  if (!depositIsNativeCurrency) {
    preCalls.push(
      ...(await planPermit2Calls(chainId, depositToken, depositAmount)),
    );
  }

  // Refresh tick
  pool = await loadV4Pool(chainId, poolKey);
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
  }

  // Rebuild liquidity if ticks changed
  let finalLiquidity = liquidity;
  if (finalLower !== tickLower || finalUpper !== tickUpper) {
    const pos2 = V4Position.fromAmounts({
      pool: new V4Pool(
        c0,
        c1,
        pool.fee,
        pool.tickSpacing,
        poolKey.hooks,
        pool.sqrtPriceX96.toString(),
        pool.liquidity.toString(),
        pool.tick,
      ),
      tickLower: finalLower,
      tickUpper: finalUpper,
      amount0: amount0Desired.toString(),
      amount1: amount1Desired.toString(),
      useFullPrecision: true,
    });
    finalLiquidity = BigInt(pos2.liquidity.toString());
  }

  const recipient = getHotWalletAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const useNative = depositIsNativeCurrency;
  const unlockData = encodeMintUnlockData({
    poolKey,
    tickLower: finalLower,
    tickUpper: finalUpper,
    liquidity: finalLiquidity,
    amount0Max: amount0Max > BigInt(0) ? amount0Max : BigInt(0),
    amount1Max: amount1Max > BigInt(0) ? amount1Max : BigInt(0),
    recipient,
    useNative,
  });

  const wallet = getWalletClient(chainId);
  const client = getPublicClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  const value = useNative ? depositAmount : BigInt(0);

  if (preCalls.length === 0) {
    try {
      await client.simulateContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'modifyLiquidities',
        args: [unlockData, deadline],
        account: recipient,
        value,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[v4 mint simulate failed]', msg);
      throw new Error(
        `v4 mint would revert. tick=${pool.tick} range=[${finalLower},${finalUpper}] ` +
          `deposit=${isToken0 ? 'token0' : 'token1'}. ${msg.slice(0, 240)}`,
      );
    }
  }

  const nextIdBefore = await client.readContract({
    address: posm,
    abi: v4PositionManagerAbi,
    functionName: 'nextTokenId',
  });

  const mintCall: RhTxCall = {
    to: posm,
    data: encodeFunctionData({
      abi: v4PositionManagerAbi,
      functionName: 'modifyLiquidities',
      args: [unlockData, deadline],
    }),
    value,
    gas: BigInt('1200000'),
  };
  const { hash: batchHash } = await executeRhWalletCalls({
    publicClient: client,
    walletClient: wallet,
    account: recipient,
    calls: [...preCalls, mintCall],
  });
  const hash = batchHash as Hash;
  if (wrap) wrap = { hash, amount: wrap.amount };

  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`v4 mint tx reverted: ${hash}`);
  }

  // tokenId = nextTokenId was assigned then incremented → minted id is nextIdBefore
  let tokenId = nextIdBefore;
  try {
    const owner = await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'ownerOf',
      args: [tokenId],
    });
    if (owner.toLowerCase() !== recipient.toLowerCase()) {
      // fallback: nextIdBefore - something; try nextIdBefore if still owned
      tokenId = nextIdBefore;
    }
  } catch {
    // try Transfer logs
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== posm.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({
          abi: v4PositionManagerAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'Transfer') {
          const args = decoded.args as { to: Address; tokenId: bigint };
          if (args.to?.toLowerCase() === recipient.toLowerCase()) {
            tokenId = args.tokenId;
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  // Resolve display token addresses (map native → wrapped for ledger)
  const token0Addr =
    poolKey.currency0.toLowerCase() === ZERO ? wrapped : poolKey.currency0;
  const token1Addr =
    poolKey.currency1.toLowerCase() === ZERO ? wrapped : poolKey.currency1;

  return {
    protocol: 'v4',
    hash,
    tokenId,
    amount0: amount0Desired,
    amount1: amount1Desired,
    tickLower: finalLower,
    tickUpper: finalUpper,
    currentTick: pool.tick,
    depositToken,
    depositAmount,
    txLink: txUrl(chainId, hash),
    poolAddress: poolId,
    poolId,
    fee: poolKey.fee,
    token0: token0Addr,
    token1: token1Addr,
    wrap,
  };
}

export async function describeV4MintPreview(params: {
  chainId: SupportedChainId;
  poolId: Hex;
  poolKey: V4PoolKey;
  depositToken: Address;
  balancePercent: number;
  sizeMode?: SizeMode;
  fixedAmountHuman?: number;
  widthPercent: number;
  edgeBufferPercent?: number;
}): Promise<string> {
  const pool = await loadV4Pool(params.chainId, params.poolKey);
  const wrapped = CHAINS[params.chainId].wrapped;
  const isToken0 = currencyIsDeposit(params.poolKey.currency0, params.depositToken, wrapped);
  const depositIsNative =
    (isToken0 && params.poolKey.currency0.toLowerCase() === ZERO) ||
    (!isToken0 && params.poolKey.currency1.toLowerCase() === ZERO);
  const effToken = depositIsNative ? wrapped : params.depositToken;
  const depMeta = await getTokenMeta(params.chainId, effToken);
  const eff = await getEffectiveDepositBalance(params.chainId, effToken);
  const amount = resolveDepositAmount(eff.effective, {
    sizeMode: params.sizeMode ?? 'percent',
    balancePercent: params.balancePercent,
    fixedAmountHuman: params.fixedAmountHuman ?? 0.1,
    decimals: depMeta.decimals,
    symbol: depMeta.symbol,
  });
  const amountHuman = humanToFloat(amount, depMeta.decimals);
  const px = (await getTokenPriceUsd(params.chainId, effToken)) ?? 0;
  const valueUsd = amountHuman * px;
  const sizeLabel =
    (params.sizeMode ?? 'percent') === 'fixed'
      ? `${params.fixedAmountHuman ?? 0.1} fixed`
      : `${params.balancePercent}%`;

  const { tickLower, tickUpper, side } = computeSingleSidedRange({
    currentTick: pool.tick,
    tickSpacing: pool.tickSpacing,
    widthPercent: params.widthPercent,
    depositIsToken0: isToken0,
    edgeBufferPercent: params.edgeBufferPercent ?? 0,
  });

  const range = formatCompactRange({
    chainId: params.chainId,
    token0: pool.token0.address === ZERO ? wrapped : pool.token0.address,
    token1: pool.token1.address === ZERO ? wrapped : pool.token1.address,
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
    token0: pool.token0.address === ZERO ? wrapped : pool.token0.address,
    token1: pool.token1.address === ZERO ? wrapped : pool.token1.address,
    decimals0: pool.token0.decimals,
    decimals1: pool.token1.decimals,
    symbol0: pool.token0.symbol,
    symbol1: pool.token1.symbol,
    tick: pool.tick,
  });

  const sideNote = side === 'above' ? 'range ABOVE market' : 'range BELOW market';

  return (
    `Value deposited: ${formatUnits(amount, depMeta.decimals)} ${depMeta.symbol}` +
    ` (${sizeLabel} · ${formatUsd(valueUsd)})\n` +
    `Range: ${range}\n` +
    `Current price: ${currentPriceStr}\n` +
    `Pool: v4 ${pool.token0.symbol}/${pool.token1.symbol} ${(pool.fee / 10000).toFixed(2)}% · ${sideNote}`
  );
}

// ── Positions ────────────────────────────────────────────────────────

function decodeSigned24(raw: bigint): number {
  const masked = raw & BigInt('0xffffff');
  if (masked & BigInt('0x800000')) {
    return Number(masked - BigInt('0x1000000'));
  }
  return Number(masked);
}

export function decodeV4PositionInfo(info: bigint): {
  tickLower: number;
  tickUpper: number;
} {
  return {
    tickLower: decodeSigned24(info >> BigInt(8)),
    tickUpper: decodeSigned24(info >> BigInt(32)),
  };
}

/** Parallel ownerOf checks (batched) — filter to ids still owned by wallet. */
async function filterOwnedTokenIds(
  chainId: SupportedChainId,
  posm: Address,
  ownerLc: string,
  idStrs: Iterable<string>,
): Promise<bigint[]> {
  const client = getPublicClient(chainId);
  const list = [...idStrs];
  const owned: bigint[] = [];
  const batch = 15;
  for (let i = 0; i < list.length; i += batch) {
    const slice = list.slice(i, i + batch);
    const results = await Promise.all(
      slice.map(async (idStr) => {
        try {
          const id = BigInt(idStr);
          const o = await client.readContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: 'ownerOf',
            args: [id],
          });
          return (o as string).toLowerCase() === ownerLc ? id : null;
        } catch {
          return null;
        }
      }),
    );
    for (const id of results) {
      if (id != null) owned.push(id);
    }
  }
  return owned;
}

/**
 * Discover v4 PositionManager NFTs for the hot wallet (fast path).
 *
 * POSM is not ERC721Enumerable. Heavy getLogs/reverse-scan made /list hang on BSC.
 *
 * Order:
 * 1) balanceOf — if 0, only verify open ledger ids and return
 * 2) open (+ recent closed) ledger ids
 * 3) Alchemy getNFTsForOwner when available (optional)
 * 4) short reverse-scan only if still short of balanceOf (≤80 ids)
 */
async function discoverV4TokenIds(chainId: SupportedChainId, knownTokenIds: bigint[] = []): Promise<bigint[]> {
  const t0 = Date.now();
  const owner = getHotWalletAddress();
  const posm = CHAINS[chainId].v4PositionManager;
  const ids = new Set<string>();
  const client = getPublicClient(chainId);
  const ownerLc = owner.toLowerCase();

  let bal = BigInt(0);
  try {
    bal = (await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'balanceOf',
      args: [owner],
    })) as bigint;
  } catch (e) {
    console.warn('[v4] balanceOf failed', e instanceof Error ? e.message : e);
  }

  for (const id of knownTokenIds) ids.add(id.toString());

  // Fast path: no v4 NFTs — skip Alchemy/logs/scan entirely
  if (bal === BigInt(0)) {
    const owned = ids.size
      ? await filterOwnedTokenIds(chainId, posm, ownerLc, ids)
      : [];
    console.log(
      `[v4] discover chain=${chainId} balanceOf=0 candidates=${ids.size} owned=${owned.length} ${Date.now() - t0}ms`,
    );
    return owned;
  }

  // Verify current candidates before any reverse scan
  let owned = await filterOwnedTokenIds(chainId, posm, ownerLc, ids);

  // Short reverse-scan only if still missing (no multi-minute 3k scan)
  if (BigInt(owned.length) < bal) {
    let nextId = BigInt(0);
    try {
      nextId = (await client.readContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'nextTokenId',
      })) as bigint;
    } catch {
      nextId = BigInt(0);
    }
    if (nextId > BigInt(1)) {
      const maxScan = BigInt(80); // ~80 RPCs worst case, batched
      const toCheck: string[] = [];
      let scanned = BigInt(0);
      for (let id = nextId - BigInt(1); id > BigInt(0) && scanned < maxScan; id--, scanned++) {
        const s = id.toString();
        if (!ids.has(s)) toCheck.push(s);
      }
      if (toCheck.length) {
        const more = await filterOwnedTokenIds(chainId, posm, ownerLc, toCheck);
        const have = new Set(owned.map((x) => x.toString()));
        for (const id of more) {
          if (!have.has(id.toString())) owned.push(id);
        }
      }
      if (BigInt(owned.length) < bal) {
        console.warn(
          `[v4] discover incomplete chain=${chainId} balanceOf=${bal} owned=${owned.length} (scan≤${maxScan})`,
        );
      }
    }
  }

  console.log(
    `[v4] discover chain=${chainId} balanceOf=${bal} candidates=${ids.size} owned=${owned.length} ${Date.now() - t0}ms`,
  );
  return owned;
}

export async function getV4Position(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<OnChainPosition | null> {
  const client = getPublicClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;

  let poolKeyRaw: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  let info: bigint;
  let liquidity: bigint;

  try {
    const [poolAndInfo, liq] = await Promise.all([
      client.readContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'getPoolAndPositionInfo',
        args: [tokenId],
      }),
      client.readContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
    ]);
    const pk = poolAndInfo[0];
    poolKeyRaw = {
      currency0: pk.currency0 as Address,
      currency1: pk.currency1 as Address,
      fee: Number(pk.fee),
      tickSpacing: Number(pk.tickSpacing),
      hooks: pk.hooks as Address,
    };
    info = poolAndInfo[1] as bigint;
    liquidity = liq as bigint;
  } catch {
    return null;
  }

  if (liquidity === BigInt(0)) return null;

  const { tickLower, tickUpper } = decodeV4PositionInfo(info);
  const wrapped = CHAINS[chainId].wrapped;
  const token0Addr =
    poolKeyRaw.currency0.toLowerCase() === ZERO ? wrapped : poolKeyRaw.currency0;
  const token1Addr =
    poolKeyRaw.currency1.toLowerCase() === ZERO ? wrapped : poolKeyRaw.currency1;

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(chainId, token0Addr),
    getTokenMeta(chainId, token1Addr),
  ]);

  const poolId = computePoolId({
    currency0: poolKeyRaw.currency0,
    currency1: poolKeyRaw.currency1,
    fee: poolKeyRaw.fee,
    tickSpacing: poolKeyRaw.tickSpacing,
    hooks: poolKeyRaw.hooks,
  });

  let currentTick = 0;
  let amount0 = BigInt(0);
  let amount1 = BigInt(0);
  let inRange = false;
  let sqrtPriceX96 = BigInt(0);
  let poolLiq = BigInt(0);

  try {
    const [slot0, liq] = await Promise.all([
      client.readContract({
        address: CHAINS[chainId].v4StateView,
        abi: stateViewAbi,
        functionName: 'getSlot0',
        args: [poolId],
      }),
      client.readContract({
        address: CHAINS[chainId].v4StateView,
        abi: stateViewAbi,
        functionName: 'getLiquidity',
        args: [poolId],
      }),
    ]);
    sqrtPriceX96 = slot0[0] as bigint;
    currentTick = Number(slot0[1]);
    poolLiq = liq as bigint;
    inRange = currentTick >= tickLower && currentTick < tickUpper;

    const t0 = new Token(chainId, token0Addr, meta0.decimals, meta0.symbol);
    const t1 = new Token(chainId, token1Addr, meta1.decimals, meta1.symbol);
    const v4Pool = new V4Pool(
      t0,
      t1,
      poolKeyRaw.fee,
      poolKeyRaw.tickSpacing,
      poolKeyRaw.hooks,
      sqrtPriceX96.toString(),
      poolLiq.toString(),
      currentTick,
    );
    const position = new V4Position({
      pool: v4Pool,
      liquidity: liquidity.toString(),
      tickLower,
      tickUpper,
    });
    amount0 = BigInt(position.amount0.quotient.toString());
    amount1 = BigInt(position.amount1.quotient.toString());
  } catch (e) {
    console.warn('[v4 position amounts]', tokenId.toString(), e instanceof Error ? e.message : e);
  }

  // Live unclaimed fees via StateView fee growth
  let tokensOwed0 = BigInt(0);
  let tokensOwed1 = BigInt(0);
  if (liquidity > BigInt(0)) {
    const { computeV4UnclaimedFees } = await import('./fees');
    const live = await computeV4UnclaimedFees({
      chainId,
      poolId,
      tokenId,
      tickLower,
      tickUpper,
      liquidity,
    });
    tokensOwed0 = live.fees0;
    tokensOwed1 = live.fees1;
  }

  const a0 = humanToFloat(amount0, meta0.decimals);
  const a1 = humanToFloat(amount1, meta1.decimals);
  const f0 = humanToFloat(tokensOwed0, meta0.decimals);
  const f1 = humanToFloat(tokensOwed1, meta1.decimals);
  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, token0Addr),
    getTokenPriceUsd(chainId, token1Addr),
  ]);
  const valueUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);
  const unclaimedFeesUsd = f0 * (p0 ?? 0) + f1 * (p1 ?? 0);

  return {
    tokenId,
    chainId,
    protocol: 'v4',
    token0: token0Addr,
    token1: token1Addr,
    fee: poolKeyRaw.fee,
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
    poolAddress: poolId as unknown as Address,
    valueUsd,
    unclaimedFeesUsd,
    amount0Human: a0,
    amount1Human: a1,
    poolKey: poolKeyRaw,
    poolId,
  };
}

export async function listV4Positions(chainId: SupportedChainId, knownTokenIds?: bigint[]): Promise<OnChainPosition[]> {
  const ids = await discoverV4TokenIds(chainId, knownTokenIds);
  const out: OnChainPosition[] = [];
  for (const id of ids) {
    const p = await getV4Position(chainId, id);
    if (p) out.push(p);
  }
  return out;
}

// ── Close ────────────────────────────────────────────────────────────

export type V4CloseResult = {
  protocol: 'v4';
  hash: Hash;
  tokenId: bigint;
  amount0: bigint;
  amount1: bigint;
  amount0Human: number;
  amount1Human: number;
  withdrawalUsd: number;
  feesPortionUsd: number;
  txLink: string;
  token0: Address;
  token1: Address;
  symbol0: string;
  symbol1: string;
};

export async function closeV4Position(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<V4CloseResult> {
  const pos = await getV4Position(chainId, tokenId);
  if (!pos || !pos.poolKey) throw new Error(`v4 position #${tokenId} not found or empty`);

  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  const recipient = getHotWalletAddress();
  const c0 = pos.poolKey.currency0;
  const c1 = pos.poolKey.currency1;

  // Live liquidity (stale liq is a common fail — not slippage; mins are already 0)
  let liveLiq = pos.liquidity;
  try {
    liveLiq = (await client.readContract({
      address: posm,
      abi: v4PositionManagerAbi,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    })) as bigint;
  } catch {
    /* use cached */
  }

  console.log(
    `[close v4] #${tokenId} liveLiq=${liveLiq} fee=${pos.poolKey.fee} ` +
      `c0=${c0.slice(0, 10)} c1=${c1.slice(0, 10)}`,
  );

  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1800);

  type Attempt = { name: string; data: Hex; gas: bigint };
  const attempts: Attempt[] = [];

  // 1) Full exit: BURN + TAKE (amount mins = 0 → no slippage check)
  attempts.push({
    name: 'BURN+TAKE',
    data: encodeBurnUnlockData({
      tokenId,
      amount0Min: BigInt(0),
      amount1Min: BigInt(0),
      currency0: c0,
      currency1: c1,
      recipient,
    }),
    gas: BigInt('1200000'),
  });

  // 2) DECREASE all + TAKE (keep NFT; often more reliable)
  if (liveLiq > BigInt(0)) {
    attempts.push({
      name: 'DECREASE+TAKE',
      data: encodeDecreaseTakeUnlockData({
        tokenId,
        liquidity: liveLiq,
        amount0Min: BigInt(0),
        amount1Min: BigInt(0),
        currency0: c0,
        currency1: c1,
        recipient,
      }),
      gas: BigInt('1000000'),
    });
  }

  // 3) Fees only (liq already 0)
  attempts.push({
    name: 'COLLECT_FEES',
    data: encodeCollectFeesUnlockData({
      tokenId,
      currency0: c0,
      currency1: c1,
      recipient,
    }),
    gas: BigInt('600000'),
  });

  const { withRetries, sleep } = await import('./retry');
  let used = '';
  const hash = await withRetries(
    async (round) => {
      // Refresh liq each outer round and rebuild DECREASE path
      let liq = liveLiq;
      try {
        liq = (await client.readContract({
          address: posm,
          abi: v4PositionManagerAbi,
          functionName: 'getPositionLiquidity',
          args: [tokenId],
        })) as bigint;
      } catch {
        /* keep */
      }
      const roundAttempts: { name: string; data: Hex; gas: bigint }[] = [
        {
          name: 'BURN+TAKE',
          data: encodeBurnUnlockData({
            tokenId,
            amount0Min: BigInt(0),
            amount1Min: BigInt(0),
            currency0: c0,
            currency1: c1,
            recipient,
          }),
          gas: BigInt('1200000'),
        },
      ];
      if (liq > BigInt(0)) {
        roundAttempts.push({
          name: 'DECREASE+TAKE',
          data: encodeDecreaseTakeUnlockData({
            tokenId,
            liquidity: liq,
            amount0Min: BigInt(0),
            amount1Min: BigInt(0),
            currency0: c0,
            currency1: c1,
            recipient,
          }),
          gas: BigInt('1000000'),
        });
      }
      roundAttempts.push({
        name: 'COLLECT_FEES',
        data: encodeCollectFeesUnlockData({
          tokenId,
          currency0: c0,
          currency1: c1,
          recipient,
        }),
        gas: BigInt('600000'),
      });

      let lastErr = '';
      console.log(`[close v4] round ${round} liq=${liq} strategies=${roundAttempts.length}`);
      for (const att of roundAttempts) {
        try {
          const dl = deadline();
          await client.simulateContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: 'modifyLiquidities',
            args: [att.data, dl],
            account: recipient,
          });
          const h = await wallet.writeContract({
            address: posm,
            abi: v4PositionManagerAbi,
            functionName: 'modifyLiquidities',
            args: [att.data, dl],
            account: wallet.account!,
            chain: wallet.chain,
            gas: att.gas,
          });
          const receipt = await client.waitForTransactionReceipt({ hash: h });
          if (receipt.status !== 'success') {
            throw new Error(`tx reverted ${h}`);
          }
          used = att.name;
          console.log(`[close v4] ok via ${used} round=${round} tx=${h}`);
          return h;
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          console.warn(`[close v4] ${att.name} r${round}:`, lastErr.slice(0, 160));
          await sleep(400);
        }
      }
      throw new Error(
        `v4 close round ${round} failed (amountMin=0). Last: ${lastErr.slice(0, 200)}`,
      );
    },
    {
      times: 3,
      backoffMs: 1200,
      label: 'close-v4',
      shouldRetry: (err) => {
        const m = err instanceof Error ? err.message : String(err);
        return !/not found|already empty|not authorized|NotApproved/i.test(m);
      },
    },
  );

  // Best-effort burn shell if we only decreased
  if (used === 'DECREASE+TAKE' || used === 'COLLECT_FEES') {
    try {
      const liqLeft = (await client.readContract({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      })) as bigint;
      if (liqLeft === BigInt(0)) {
        const burnData = encodeBurnUnlockData({
          tokenId,
          amount0Min: BigInt(0),
          amount1Min: BigInt(0),
          currency0: c0,
          currency1: c1,
          recipient,
        });
        // Only burn if it sim succeeds
        await client.simulateContract({
          address: posm,
          abi: v4PositionManagerAbi,
          functionName: 'modifyLiquidities',
          args: [burnData, deadline()],
          account: recipient,
        });
        const bh = await wallet.writeContract({
          address: posm,
          abi: v4PositionManagerAbi,
          functionName: 'modifyLiquidities',
          args: [burnData, deadline()],
          account: wallet.account!,
          chain: wallet.chain,
          gas: BigInt('400000'),
        });
        await client.waitForTransactionReceipt({ hash: bh });
      }
    } catch {
      /* NFT may remain empty — OK */
    }
  }

  const amount0 = pos.amount0;
  const amount1 = pos.amount1;
  const a0 = pos.amount0Human;
  const a1 = pos.amount1Human;
  const [p0, p1] = await Promise.all([
    getTokenPriceUsd(chainId, pos.token0),
    getTokenPriceUsd(chainId, pos.token1),
  ]);
  const withdrawalUsd = a0 * (p0 ?? 0) + a1 * (p1 ?? 0);

  return {
    protocol: 'v4',
    hash,
    tokenId,
    amount0,
    amount1,
    amount0Human: a0,
    amount1Human: a1,
    withdrawalUsd,
    feesPortionUsd: 0,
    txLink: txUrl(chainId, hash),
    token0: pos.token0,
    token1: pos.token1,
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
  };
}

/**
 * Claim unclaimed fees only (keep liquidity / NFT).
 * Uses DECREASE(0) + TAKE_PAIR unlock path.
 */
export async function claimV4Fees(
  chainId: SupportedChainId,
  tokenId: bigint,
): Promise<{
  hash: Hash;
  tokenId: bigint;
  feesUsd: number;
  fees0: bigint;
  fees1: bigint;
  symbol0: string;
  symbol1: string;
  amount0Human: number;
  amount1Human: number;
  txLink: string;
}> {
  const pos = await getV4Position(chainId, tokenId);
  if (!pos || !pos.poolKey) throw new Error(`v4 position #${tokenId} not found`);

  const fees0 = pos.tokensOwed0;
  const fees1 = pos.tokensOwed1;
  if (fees0 === BigInt(0) && fees1 === BigInt(0)) {
    throw new Error(`No unclaimed fees on #${tokenId}`);
  }

  const client = getPublicClient(chainId);
  const wallet = getWalletClient(chainId);
  const posm = CHAINS[chainId].v4PositionManager;
  const recipient = getHotWalletAddress();
  const c0 = pos.poolKey.currency0;
  const c1 = pos.poolKey.currency1;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  const data = encodeCollectFeesUnlockData({
    tokenId,
    currency0: c0,
    currency1: c1,
    recipient,
  });

  console.log(
    `[claim v4] #${tokenId} fees0=${fees0} fees1=${fees1} estUsd=${pos.unclaimedFeesUsd}`,
  );

  await client.simulateContract({
    address: posm,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [data, deadline],
    account: recipient,
  });

  const hash = await wallet.writeContract({
    address: posm,
    abi: v4PositionManagerAbi,
    functionName: 'modifyLiquidities',
    args: [data, deadline],
    account: wallet.account!,
    chain: wallet.chain,
    gas: BigInt('700000'),
  });
  await client.waitForTransactionReceipt({ hash });

  return {
    hash,
    tokenId,
    feesUsd: pos.unclaimedFeesUsd,
    fees0,
    fees1,
    symbol0: pos.symbol0,
    symbol1: pos.symbol1,
    amount0Human: humanToFloat(fees0, pos.decimals0),
    amount1Human: humanToFloat(fees1, pos.decimals1),
    txLink: txUrl(chainId, hash),
  };
}

// silence unused imports that may be useful later
void nearestUsableTick;
void TickMath;
void formatAge;
void formatEthVal;
void uniswapPositionUrl;
