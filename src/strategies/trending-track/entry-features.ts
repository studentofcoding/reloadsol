// Buy-entry feature snapshot attachment extracted from src/app/api/trending/track/route.ts (REL-19).
import { buildFullEntryFeatureSnapshot } from '@/strategies/resolve-entry-snapshot'
import { getCurrentBotStrategySync, resolveTradingStrategy } from '@/strategies/load-strategy'
import type { TradingSimulation } from './types'

export async function attachBuyEntryFeatures(
  simulation: TradingSimulation,
  token: {
    token_address: string
    token_symbol: string | null
    market_cap: number | null
    organic_score: number | null
    top_holders_pct?: number | null
    volume_5m?: number | null
    pool_created_at?: string | null
  },
): Promise<void> {
  const entryFeatures = await buildFullEntryFeatureSnapshot(token.token_address, {
    entryAt: simulation.simulation_started_at,
    firstSeenAt: token.pool_created_at ?? undefined,
    entryMcap: token.market_cap,
    organicScore: token.organic_score,
    topHoldersPct: token.top_holders_pct ?? null,
    volume5m: token.volume_5m ?? null,
    tokenSymbol: token.token_symbol,
    skipJupiter:
      token.organic_score != null && token.top_holders_pct != null,
  })

  let features = entryFeatures
  try {
    const { attachOhlcRugShadow } = await import('@/strategies/ohlc-rug-shadow')
    const ohlc = await attachOhlcRugShadow(token.token_address, entryFeatures, {
      enforce: false,
    })
    const { attachMlEntryShadow } = await import('@/strategies/ml-entry-shadow')
    const ml = await attachMlEntryShadow(ohlc.features, { enforce: false })
    features = ml.features
  } catch {
    /* keep base features */
  }

  // ML2 exit overlay: audit always; apply TP/SL only for sim (never live SL/TP tracker)
  try {
    const { trendingBotToCanonical } = await import('@/strategies/canonical-params')
    const { resolveExitOverlayForOpen } = await import(
      '@/strategies/potential-exit-overlay'
    )
    const simRec = simulation as unknown as Record<string, unknown>
    const strategyId =
      typeof simRec.strategy_id === 'string'
        ? simRec.strategy_id
        : getCurrentBotStrategySync()
    const strategy = resolveTradingStrategy(strategyId)
    const canonical = trendingBotToCanonical(strategy)
    const overlayResult = await resolveExitOverlayForOpen({
      baseExit: canonical.exit,
      features,
      mintAddress: token.token_address,
      strategyId: strategy.id,
      persistEffectiveExit: simulation.is_simulated === true,
    })
    features = overlayResult.features

    if (overlayResult.effectiveExit && simulation.is_simulated) {
      const exit = overlayResult.overlay.effective
      const ladder = exit.takeProfitLadder
      const tp1 = exit.takeProfitPct
      const baseTp1 = simulation.take_profit_levels.tp1_percentage
      const tp2 =
        ladder && ladder.length > 1
          ? ladder[1]
          : simulation.take_profit_levels.tp2_percentage *
            (tp1 / Math.max(baseTp1, 1))
      simulation.stop_loss_percentage = exit.stopLossPct
      simulation.max_hold_hours = exit.maxHoldHours
      simulation.take_profit_levels = {
        ...simulation.take_profit_levels,
        tp1_percentage: tp1,
        tp2_percentage: tp2,
        ...(ladder && ladder.length > 2
          ? { tp3_percentage: ladder[2] }
          : {}),
      }
      simRec.effective_exit = overlayResult.effectiveExit
    }
  } catch {
    /* overlay optional */
  }

  ;(simulation as unknown as Record<string, unknown>).entry_features = features
}
