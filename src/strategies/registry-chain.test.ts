import { describe, expect, it } from 'vitest'
import {
  GMGN_STRATEGIES,
  MCAP_TRACKER_STRATEGIES,
  SIGNALS_STRATEGIES,
  TRENDING_BOT_STRATEGIES,
} from './registry'
import { decideRhTrendingExit } from './trending-bot-rh-sim'
import { simWalletForChain } from './sim-wallets'
import type { TrendingBotStrategy } from './types'

const RH_IDS = [
  'att_rh',
  'mcap_enter_first_seen_rh',
  'mcap_enter_at_80_rh',
  'signals_default_rh',
  'gmgn_smartmoney_rh',
  'gmgn_kol_momentum_rh',
]

const ALL = {
  ...TRENDING_BOT_STRATEGIES,
  ...SIGNALS_STRATEGIES,
  ...MCAP_TRACKER_STRATEGIES,
  ...GMGN_STRATEGIES,
} as Record<string, { chain?: string; execution_mode?: string }>

describe('robinhood strategy definitions', () => {
  it('seeds every _rh variant', () => {
    for (const id of RH_IDS) expect(ALL[id], id).toBeDefined()
  })

  it('is paper-only and chain-tagged', () => {
    for (const [id, s] of Object.entries(ALL)) {
      if (!id.endsWith('_rh')) {
        expect(s.chain ?? 'sol', id).toBe('sol')
        continue
      }
      expect(s.chain, id).toBe('robinhood')
      expect(s.execution_mode, id).toBe('sim_only')
    }
  })

  it('sizes robinhood entries in native ETH', () => {
    expect(TRENDING_BOT_STRATEGIES.att_rh.buy_amount_native).toBeGreaterThan(0)
    expect(
      SIGNALS_STRATEGIES.signals_default_rh.config.execution.simBuyNative,
    ).toBeGreaterThan(0)
    expect(
      MCAP_TRACKER_STRATEGIES.mcap_enter_first_seen_rh.config.execution
        .simBuyNative,
    ).toBeGreaterThan(0)
    expect(
      GMGN_STRATEGIES.gmgn_smartmoney_rh.config.execution.simBuyNative,
    ).toBeGreaterThan(0)
  })

  it('keeps robinhood paper PnL in its own wallet', () => {
    expect(simWalletForChain('signals-strategy-sim', 'robinhood')).toBe(
      'signals-strategy-sim-rh',
    )
    expect(simWalletForChain('signals-strategy-sim', 'sol')).toBe(
      'signals-strategy-sim',
    )
  })
})

describe('robinhood trending exit ladder', () => {
  const strategy = TRENDING_BOT_STRATEGIES.att_rh as TrendingBotStrategy

  it('takes a partial at tp1 and closes at tp2', () => {
    expect(
      decideRhTrendingExit({ strategy, gainPct: 50, heldHours: 1, tp1Done: false }),
    ).toEqual({ action: 'partial', sellPct: 90, reason: 'tp1' })
    expect(
      decideRhTrendingExit({ strategy, gainPct: 50, heldHours: 1, tp1Done: true }).action,
    ).toBe('hold')
    expect(
      decideRhTrendingExit({ strategy, gainPct: 120, heldHours: 1, tp1Done: true }),
    ).toEqual({ action: 'close', reason: 'tp2' })
  })

  it('closes on stop loss and on max hold', () => {
    expect(
      decideRhTrendingExit({ strategy, gainPct: -40, heldHours: 1, tp1Done: false }),
    ).toEqual({ action: 'close', reason: 'stop_loss' })
    expect(
      decideRhTrendingExit({ strategy, gainPct: 5, heldHours: 25, tp1Done: false }),
    ).toEqual({ action: 'close', reason: 'max_hold' })
    expect(
      decideRhTrendingExit({ strategy, gainPct: 5, heldHours: 1, tp1Done: false }).action,
    ).toBe('hold')
  })
})
