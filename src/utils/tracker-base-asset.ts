import { TOKENS } from '@/utils/solana'

/** Manual tracker buy default, in USD of the chosen base asset. */
export const TRACKER_BUY_DEFAULT_USD = 10

export type TrackerBaseAsset = 'SOL' | 'USDC' | 'USDT'

export type TrackerBaseBalances = {
  /** Native SOL, human units. */
  solUi: number | null
  /**
   * Native SOL priced in USD. Null when the price feed is unavailable
   * (raw human-unit comparison is used instead).
   */
  solUsd: number | null
  /** USDC human units. Treated as USD. */
  usdcUi: number | null
  /** USDT human units. Treated as USD. */
  usdtUi: number | null
}

export type TrackerTradeSide = 'buy' | 'sell'

function positive(n: number | null | undefined): number {
  return n != null && Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Buy route for the tracker. SOL stays the input when it is worth at least as
 * much as the larger stable. USDC/USDT wins only when that stable is strictly
 * larger. USDT is used when it is the larger stable.
 */
export function pickTrackerBaseAsset(
  balances: TrackerBaseBalances,
): TrackerBaseAsset {
  const usdc = positive(balances.usdcUi)
  const usdt = positive(balances.usdtUi)
  const stable: TrackerBaseAsset = usdt > usdc ? 'USDT' : 'USDC'
  const stableUsd = stable === 'USDT' ? usdt : usdc
  const solUsd = balances.solUsd
  if (solUsd != null && Number.isFinite(solUsd)) {
    if (stableUsd > solUsd && stableUsd > 0) return stable
    return 'SOL'
  }
  if (stableUsd > positive(balances.solUi) && stableUsd > 0) return stable
  return 'SOL'
}

export function trackerBaseSpec(asset: TrackerBaseAsset): {
  mint: string
  decimals: number
} {
  if (asset === 'SOL') return { mint: TOKENS.SOL, decimals: 9 }
  if (asset === 'USDC') return { mint: TOKENS.USDC, decimals: 6 }
  return { mint: TOKENS.USDT, decimals: 6 }
}

/** $10 of the base, in human units. Empty when SOL has no USD price. */
export function defaultBuyAmountHuman(
  asset: TrackerBaseAsset,
  solPriceUsd: number | null,
): string {
  if (asset === 'USDC' || asset === 'USDT') return String(TRACKER_BUY_DEFAULT_USD)
  if (solPriceUsd == null || !Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    return ''
  }
  const sol = TRACKER_BUY_DEFAULT_USD / solPriceUsd
  return sol
    .toFixed(6)
    .replace(/0+$/, '')
    .replace(/\.$/, '')
}

export function humanToRawAmount(human: number, decimals: number): number {
  if (!Number.isFinite(human) || human <= 0 || decimals < 0) return 0
  const raw = human * 10 ** decimals
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.floor(raw + 1e-6)
}

export function percentOfRaw(balanceRaw: number, percent: number): number {
  if (!Number.isFinite(balanceRaw) || balanceRaw <= 0) return 0
  const pct = Math.min(100, Math.max(0, percent))
  if (pct <= 0) return 0
  return Math.floor((balanceRaw * pct) / 100)
}

export function trackerTradeLeg(params: {
  side: TrackerTradeSide
  asset: TrackerBaseAsset
  tokenMint: string
  buyHuman?: number
  sellBalanceRaw?: number
  sellPercent?: number
}): { inputMint: string; outputMint: string; amountRaw: number } {
  const base = trackerBaseSpec(params.asset)
  if (params.side === 'buy') {
    return {
      inputMint: base.mint,
      outputMint: params.tokenMint,
      amountRaw: humanToRawAmount(params.buyHuman ?? 0, base.decimals),
    }
  }
  return {
    inputMint: params.tokenMint,
    outputMint: base.mint,
    amountRaw: percentOfRaw(
      params.sellBalanceRaw ?? 0,
      params.sellPercent ?? 0,
    ),
  }
}
