import { createPublicClient, http, type Address } from 'viem'
import type { RhUniv2Position } from '@/types/dlmm'
import {
  RH_CHAIN,
  RH_USDG,
  RH_WETH,
  erc20Abi,
  getRhRpcUrl,
  normalizeAddress,
  univ2PairAbi,
} from '@/utils/dlmm/rh-univ2'

function quoteUsdPerUnit(quoteSymbol: 'USDG' | 'WETH', ethUsd: number): number {
  if (quoteSymbol === 'USDG') return 1
  return ethUsd > 0 ? ethUsd : 0
}

export async function markRhUniv2Position(
  position: RhUniv2Position,
): Promise<{ current_value_usd: number; pnl_pct: number }> {
  const client = createPublicClient({
    chain: RH_CHAIN,
    transport: http(getRhRpcUrl()),
  })

  const pool = position.lp_token_address as Address
  const owner = position.owner_address as Address

  const [lpBal, totalSupply, reserves, token0] = await Promise.all([
    client.readContract({
      address: pool,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    }),
    client.readContract({
      address: pool,
      abi: univ2PairAbi,
      functionName: 'totalSupply',
    }),
    client.readContract({
      address: pool,
      abi: univ2PairAbi,
      functionName: 'getReserves',
    }),
    client.readContract({
      address: pool,
      abi: univ2PairAbi,
      functionName: 'token0',
    }),
  ])

  if (lpBal <= BigInt(0) || totalSupply <= BigInt(0)) {
    return { current_value_usd: 0, pnl_pct: -100 }
  }

  const reserve0 = reserves[0] as bigint
  const reserve1 = reserves[1] as bigint
  const t0 = normalizeAddress(token0 as string)
  const quoteIs0 =
    (position.quote_symbol === 'USDG' && t0 === normalizeAddress(RH_USDG)) ||
    (position.quote_symbol === 'WETH' && t0 === normalizeAddress(RH_WETH))

  const reserveQuote = quoteIs0 ? reserve0 : reserve1
  const reserveBase = quoteIs0 ? reserve1 : reserve0

  const quoteShare = (reserveQuote * lpBal) / totalSupply
  const baseShare = (reserveBase * lpBal) / totalSupply
  const spot =
    reserveBase > BigInt(0) ? Number(reserveQuote) / Number(reserveBase) : 0
  const quoteUnits = Number(quoteShare) + Number(baseShare) * spot

  // Reserves are in wei-ish units; normalize by 1e18 for both (USDG/WETH are 18 on RH)
  const quoteHuman = quoteUnits / 1e18
  // ponytail: no live ETH/USD oracle — USDG @ $1; WETH marks scale from entry_value/entry_quote.
  const px = quoteUsdPerUnit(position.quote_symbol, 0)
  let current_value_usd =
    quoteHuman * (px || (position.quote_symbol === 'USDG' ? 1 : 0))
  if (
    position.quote_symbol === 'WETH' &&
    current_value_usd === 0 &&
    position.entry_quote_amount > 0
  ) {
    const entryPx = position.entry_value_usd / position.entry_quote_amount
    current_value_usd = quoteHuman * entryPx
  }

  const entry = position.entry_value_usd
  const pnl_pct = entry > 0 ? ((current_value_usd - entry) / entry) * 100 : 0
  return { current_value_usd, pnl_pct }
}
