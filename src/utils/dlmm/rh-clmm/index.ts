import type { Address } from 'viem'
import {
  CHAINS,
  DEFAULT_BALANCE_PERCENT,
  DEFAULT_WIDTH_PERCENT,
  RH_CHAIN_ID,
} from './config'
import { withRhClmmCtx, type RhClmmCtx } from './clients'
import { closePosition } from './close'
import { describeMintPreview, mintSingleSided } from './mint'
import { listPoolsForToken, loadPool, type ListedPool } from './pools'
import { listPositions } from './positions'

export type QuickMintOptions = {
  widthPercent?: number
  balancePercent?: number
}

const ZERO = '0x0000000000000000000000000000000000000000'

function pickDepositFromLegs(token0: Address, token1: Address): Address {
  const chain = CHAINS[RH_CHAIN_ID]
  const currencies = [token0, token1]
  const matches = (address: Address) =>
    currencies.some(
      (currency) =>
        currency.toLowerCase() === address.toLowerCase() ||
        (currency.toLowerCase() === ZERO &&
          address.toLowerCase() === chain.wrapped.toLowerCase()),
    )

  if (matches(chain.wrapped)) return chain.wrapped
  if (matches(chain.usdg)) return chain.usdg
  // Fallback: token1 (often quote)
  return token1
}

function pickDepositAsset(pool: ListedPool): Address {
  return pickDepositFromLegs(pool.token0, pool.token1)
}

async function topPoolAndDeposit(ca: Address) {
  const pools = await listPoolsForToken(RH_CHAIN_ID, ca)
  const pool = pools[0]
  if (!pool) throw new Error('No Uniswap v3/v4 pool meeting the minimum TVL was found')
  return { pool, depositToken: pickDepositAsset(pool) }
}

/** Mint into a specific univ3 pool contract (LP Terminal row). */
export async function previewMintPool(
  poolAddress: Address,
  ctx: RhClmmCtx,
  opts: QuickMintOptions = {},
) {
  return withRhClmmCtx(ctx, async () => {
    const pool = await loadPool(RH_CHAIN_ID, poolAddress)
    const depositToken = pickDepositFromLegs(
      pool.token0.address,
      pool.token1.address,
    )
    const text = await describeMintPreview({
      chainId: RH_CHAIN_ID,
      poolAddress,
      protocol: 'v3',
      depositToken,
      widthPercent: opts.widthPercent ?? DEFAULT_WIDTH_PERCENT,
      balancePercent: opts.balancePercent ?? DEFAULT_BALANCE_PERCENT,
    })
    return {
      text,
      depositToken,
      token0: pool.token0.address,
      token1: pool.token1.address,
      fee: pool.fee,
      symbol0: pool.token0.symbol,
      symbol1: pool.token1.symbol,
    }
  })
}

export async function mintPool(
  poolAddress: Address,
  ctx: RhClmmCtx,
  opts: QuickMintOptions = {},
) {
  return withRhClmmCtx(ctx, async () => {
    const pool = await loadPool(RH_CHAIN_ID, poolAddress)
    const depositToken = pickDepositFromLegs(
      pool.token0.address,
      pool.token1.address,
    )
    return mintSingleSided({
      chainId: RH_CHAIN_ID,
      poolAddress,
      protocol: 'v3',
      depositToken,
      widthPercent: opts.widthPercent ?? DEFAULT_WIDTH_PERCENT,
      balancePercent: opts.balancePercent ?? DEFAULT_BALANCE_PERCENT,
    })
  })
}

export async function listPoolsForTokenCa(ca: Address, ctx: RhClmmCtx) {
  return withRhClmmCtx(ctx, () => listPoolsForToken(RH_CHAIN_ID, ca))
}

export async function previewQuickMint(ca: Address, ctx: RhClmmCtx, opts: QuickMintOptions = {}) {
  return withRhClmmCtx(ctx, async () => {
    const { pool, depositToken } = await topPoolAndDeposit(ca)
    return describeMintPreview({
      chainId: RH_CHAIN_ID,
      poolAddress: pool.poolAddress,
      poolId: pool.poolId,
      poolKey: pool.poolKey,
      protocol: pool.protocol,
      depositToken,
      widthPercent: opts.widthPercent ?? DEFAULT_WIDTH_PERCENT,
      balancePercent: opts.balancePercent ?? DEFAULT_BALANCE_PERCENT,
    })
  })
}

export async function mintQuick(ca: Address, ctx: RhClmmCtx, opts: QuickMintOptions = {}) {
  return withRhClmmCtx(ctx, async () => {
    const { pool, depositToken } = await topPoolAndDeposit(ca)
    return mintSingleSided({
      chainId: RH_CHAIN_ID,
      poolAddress: pool.poolAddress,
      poolId: pool.poolId,
      poolKey: pool.poolKey,
      protocol: pool.protocol,
      depositToken,
      widthPercent: opts.widthPercent ?? DEFAULT_WIDTH_PERCENT,
      balancePercent: opts.balancePercent ?? DEFAULT_BALANCE_PERCENT,
    })
  })
}

export async function listOwnerPositions(ctx: RhClmmCtx, knownV4TokenIds?: bigint[]) {
  return withRhClmmCtx(ctx, () => listPositions(RH_CHAIN_ID, knownV4TokenIds))
}

export async function closeOwnerPosition(
  ctx: RhClmmCtx,
  tokenId: bigint,
  protocol: 'v3' | 'v4',
) {
  return withRhClmmCtx(ctx, () => closePosition(RH_CHAIN_ID, tokenId, protocol))
}

export type { RhClmmCtx } from './clients'
