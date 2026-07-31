// Mappers / simulation factory extracted from src/app/api/trending/track/route.ts (REL-19).
import type { JupiterPool } from '@/types'
import { resolveTradingStrategy } from '@/strategies/load-strategy'
import type { TradingSimulation } from './types'

export function mapPoolToTrackedToken(pool: JupiterPool) {
  const topHolders = pool.baseAsset.audit?.topHoldersPercentage
  const poolCreatedAt =
    pool.createdAt != null
      ? new Date(
          typeof pool.createdAt === 'number' ? pool.createdAt : pool.createdAt,
        ).toISOString()
      : null

  return {
    token_address: pool.baseAsset.id,
    token_symbol: pool.baseAsset.symbol,
    token_name: pool.baseAsset.name,
    logo_url: pool.baseAsset.icon,
    current_price: pool.baseAsset.usdPrice,
    organic_score: pool.baseAsset.organicScore,
    market_cap: pool.baseAsset.mcap,
    volume_1h: pool.baseAsset.stats1h.buyVolume,
    volume_5m: pool.baseAsset.stats5m?.buyVolume ?? null,
    top_holders_pct:
      typeof topHolders === 'number' && Number.isFinite(topHolders)
        ? topHolders
        : null,
    pool_created_at: poolCreatedAt,
    change_1h: (pool.baseAsset.stats1h?.priceChange ?? 0) / 100,
    change_5m: (pool.baseAsset.stats5m?.priceChange ?? 0) / 100,
  }
}

export function createTradingSimulation(
  token: { token_address: string; token_symbol: string | null },
  strategyId?: string,
  isRealTradingActive: boolean = false,
  keypairPath?: string,
  startTime?: string,
): TradingSimulation {
  const strategy = resolveTradingStrategy(strategyId)

  return {
    token_address: token.token_address,
    token_symbol: token.token_symbol,
    simulation_started_at: startTime || new Date().toISOString(),
    buy_operation: null,
    sell_operations: [],
    current_status: 'buying',
    remaining_token_amount: '0',
    initial_token_amount: '0',
    is_simulated: !isRealTradingActive,
    keypair_path: keypairPath,
    take_profit_levels: { ...strategy.take_profit_levels },
    stop_loss_percentage: strategy.stop_loss_percentage,
    max_hold_hours: strategy.max_hold_hours,
    final_result: null,
  }
}

export function calculatePeakPrice(currentPrice: number, existingPeakPrice: number): number {
  // Ensure we don't store invalid peak prices
  if (currentPrice <= 0) return existingPeakPrice

  // If no existing peak price (0), set current as peak
  if (!existingPeakPrice) return currentPrice

  // Only update peak if current is higher
  return currentPrice > existingPeakPrice ? currentPrice : existingPeakPrice
}
