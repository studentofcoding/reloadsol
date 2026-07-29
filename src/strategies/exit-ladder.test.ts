import { describe, expect, it } from 'vitest'
import { decideRhTrendingExit, decideTrendingExit } from './exit-ladder'
import { TRENDING_BOT_STRATEGIES } from './registry'
import type { TrendingBotStrategy } from './types'

const att = TRENDING_BOT_STRATEGIES.att as TrendingBotStrategy
const scalper = TRENDING_BOT_STRATEGIES.scalper as TrendingBotStrategy

/** Solana cycle semantics (shouldSellToken in /api/trending/track). */
function solExit(
  strategy: TrendingBotStrategy,
  gainPct: number,
  heldHours: number,
  tp1Done: boolean,
) {
  return decideTrendingExit({
    takeProfitLevels: strategy.take_profit_levels,
    stopLossPct: strategy.stop_loss_percentage,
    maxHoldHours: strategy.max_hold_hours,
    gainPct,
    heldHours,
    tp1Done,
    tp3Style: 'trailing',
    tp2RequiresTp1: true,
  })
}

describe('decideTrendingExit — solana cycle semantics', () => {
  it('stop loss closes everything first', () => {
    expect(solExit(att, -40, 1, false)).toEqual({ action: 'close', reason: 'stop_loss' })
    expect(solExit(att, -35, 1, false)).toEqual({ action: 'close', reason: 'stop_loss' })
  })

  it('tp1 fires as a partial before tp2 when tp1 not done', () => {
    // gain above tp2 but tp1 not executed yet — solana takes the tp1 partial first
    expect(solExit(att, 120, 1, false)).toEqual({
      action: 'partial',
      sellPct: 90,
      reason: 'tp1',
    })
  })

  it('tp2 closes only after tp1 executed', () => {
    expect(solExit(att, 120, 1, true)).toEqual({ action: 'close', reason: 'tp2' })
    expect(solExit(att, 50, 1, true).action).toBe('hold')
  })

  it('tp3 trailing closes when gain falls back after tp1 (scalper)', () => {
    // scalper: tp1 15, tp2 25, tp3 40 enabled — after tp1, gain <= 40 closes
    expect(solExit(scalper, 20, 1, true)).toEqual({ action: 'close', reason: 'tp3' })
    // above tp2 closes via tp2 first
    expect(solExit(scalper, 30, 1, true)).toEqual({ action: 'close', reason: 'tp2' })
    // tp3 trailing never fires before tp1
    expect(solExit(scalper, 5, 1, false).action).toBe('hold')
  })

  it('max hold closes regardless of gain', () => {
    expect(solExit(att, 5, 24, false)).toEqual({ action: 'close', reason: 'max_hold' })
    expect(solExit(att, 5, 23, false).action).toBe('hold')
  })
})

describe('decideRhTrendingExit — robinhood twin semantics', () => {
  const attRh = TRENDING_BOT_STRATEGIES.att_rh as TrendingBotStrategy
  const moonbag = TRENDING_BOT_STRATEGIES.lowcap_moonbag as TrendingBotStrategy

  it('tp2 closes even when tp1 not done', () => {
    expect(
      decideRhTrendingExit({ strategy: attRh, gainPct: 120, heldHours: 1, tp1Done: false }),
    ).toEqual({ action: 'close', reason: 'tp2' })
  })

  it('tp3 profit target closes when enabled (moonbag)', () => {
    expect(
      decideRhTrendingExit({ strategy: moonbag, gainPct: 650, heldHours: 1, tp1Done: true }),
    ).toEqual({ action: 'close', reason: 'tp3' })
  })

  it('tp1 with sell 100% closes instead of partial', () => {
    const fullTp1: TrendingBotStrategy = {
      ...attRh,
      take_profit_levels: { ...attRh.take_profit_levels, tp1_sell_percentage: 100 },
    }
    expect(
      decideRhTrendingExit({ strategy: fullTp1, gainPct: 50, heldHours: 1, tp1Done: false }),
    ).toEqual({ action: 'close', reason: 'tp1' })
  })
})
