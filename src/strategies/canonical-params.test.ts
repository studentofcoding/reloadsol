import { describe, expect, it } from 'vitest'
import {
  dlmmToCanonical,
  mcapTrackerToCanonical,
  signalsToCanonical,
  trendingBotToCanonical,
  mapRegistryToCanonical,
} from './canonical-params'
import {
  DLMM_STRATEGY_DEFAULTS,
  MCAP_TRACKER_STRATEGIES,
  SIGNALS_STRATEGIES,
  TRENDING_BOT_STRATEGIES,
} from './registry'

describe('strategy param adapters', () => {
  it('maps trending_bot to StrategyParameterSet', () => {
    const att = TRENDING_BOT_STRATEGIES.att
    const c = trendingBotToCanonical(att)
    expect(c.domain).toBe('trending_bot')
    expect(c.strategyId).toBe('att')
    expect(c.positionSizeSol).toBe(att.buy_amount_sol)
    expect(c.entry.trigger).toBe('filter_assign')
    expect(c.exit.stopLossPct).toBe(att.stop_loss_percentage)
    expect(c.exit.takeProfitLadder?.length).toBeGreaterThanOrEqual(2)
  })

  it('maps signals to StrategyParameterSet', () => {
    const s = SIGNALS_STRATEGIES.signals_default
    const c = signalsToCanonical(s)
    expect(c.domain).toBe('signals')
    expect(c.entry.trigger).toBe('signals_score')
    expect(c.positionSizeSol).toBe(s.config.execution.simBuySol)
    expect(c.entry.enterScoreFloor).toBe(50)
  })

  it('maps mcap_tracker to StrategyParameterSet', () => {
    const s = MCAP_TRACKER_STRATEGIES.mcap_enter_at_80
    const c = mcapTrackerToCanonical(s)
    expect(c.domain).toBe('mcap_tracker')
    expect(c.entry.trigger).toBe('milestone_80')
    expect(c.exit.takeProfitPct).toBe(200)
    expect(c.exit.stopLossPct).toBe(-50)
  })

  it('maps dlmm to StrategyParameterSet', () => {
    const c = dlmmToCanonical(DLMM_STRATEGY_DEFAULTS)
    expect(c.domain).toBe('dlmm')
    expect(c.entry.trigger).toBe('dlmm_pool_screen')
    expect(c.entry.minTvl).toBe(50_000)
    expect(c.exit.oorTimeoutMin).toBe(16)
    expect(c.positionSizeSol).toBe(1)
  })

  it('mapRegistryToCanonical includes all four domains', () => {
    const map = mapRegistryToCanonical({
      trending: TRENDING_BOT_STRATEGIES,
      signals: SIGNALS_STRATEGIES,
      mcap: MCAP_TRACKER_STRATEGIES,
      dlmm: DLMM_STRATEGY_DEFAULTS,
    })
    expect(map.att?.domain).toBe('trending_bot')
    expect(map.signals_default?.domain).toBe('signals')
    expect(map.mcap_enter_first_seen?.domain).toBe('mcap_tracker')
    expect(map.dlmm_default?.domain).toBe('dlmm')
  })
})
