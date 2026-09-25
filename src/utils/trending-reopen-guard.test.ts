import { describe, expect, it } from 'vitest'
import { trendingBlockedKeys, trendingReentryKey } from './trending-reopen-guard'

const NOW = Date.parse('2026-09-25T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const cooldownOnly = {
  cooldownMinutes: 1440,
  maxPurchasesPerToken: 0,
  now: NOW,
}

describe('trendingBlockedKeys', () => {
  it('blocks a mint closed within the cooldown', () => {
    const rows = [{ strategy_id: 'att_rh', token_address: 'M1', exit_at: iso(60_000) }]
    expect(trendingBlockedKeys(rows, cooldownOnly).has(trendingReentryKey('att_rh', 'M1'))).toBe(true)
  })

  it('allows a mint closed outside the cooldown', () => {
    const rows = [{ strategy_id: 'att_rh', token_address: 'M1', exit_at: iso(25 * 60 * 60 * 1000) }]
    expect(trendingBlockedKeys(rows, cooldownOnly).size).toBe(0)
  })

  it('isolates per strategy', () => {
    const rows = [{ strategy_id: 'scalper', token_address: 'M1', exit_at: iso(60_000) }]
    const blocked = trendingBlockedKeys(rows, cooldownOnly)
    expect(blocked.has(trendingReentryKey('att', 'M1'))).toBe(false)
    expect(blocked.has(trendingReentryKey('scalper', 'M1'))).toBe(true)
  })

  it('falls back to created_at when exit_at is missing', () => {
    const rows = [
      { strategy_id: 'att_rh', token_address: 'M1', exit_at: null, created_at: iso(60_000) },
    ]
    expect(trendingBlockedKeys(rows, cooldownOnly).has(trendingReentryKey('att_rh', 'M1'))).toBe(true)
  })

  it('disables the cooldown when cooldownMinutes <= 0', () => {
    const rows = [{ strategy_id: 'att_rh', token_address: 'M1', exit_at: iso(60_000) }]
    expect(trendingBlockedKeys(rows, { ...cooldownOnly, cooldownMinutes: 0 }).size).toBe(0)
  })

  it('blocks once the lifetime purchase cap is reached', () => {
    const rows = [
      { strategy_id: 'att_rh', token_address: 'M1', exit_at: iso(40 * DAY_MS) },
      { strategy_id: 'att_rh', token_address: 'M1', exit_at: iso(50 * DAY_MS) },
    ]
    const blocked = trendingBlockedKeys(rows, {
      cooldownMinutes: 0,
      maxPurchasesPerToken: 2,
      now: NOW,
    })
    expect(blocked.has(trendingReentryKey('att_rh', 'M1'))).toBe(true)
  })

  it('keeps a mint below both thresholds open', () => {
    const rows = [{ strategy_id: 'att_rh', token_address: 'M1', exit_at: iso(40 * DAY_MS) }]
    const blocked = trendingBlockedKeys(rows, {
      cooldownMinutes: 1440,
      maxPurchasesPerToken: 2,
      now: NOW,
    })
    expect(blocked.size).toBe(0)
  })
})
