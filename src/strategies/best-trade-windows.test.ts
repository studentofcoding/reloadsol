import { describe, expect, it } from 'vitest'
import {
  computeBestTradeWindows,
  formatHourRangeLabel,
  hourInTimeZone,
  resolveReportTimeZone,
} from './best-trade-windows'
import type { StrategyOutcomeRow } from './types'

function outcome(
  partial: Partial<StrategyOutcomeRow> &
    Pick<StrategyOutcomeRow, 'id' | 'strategy_id' | 'pnl_pct' | 'entry_at'>,
): StrategyOutcomeRow {
  return {
    domain: 'mcap_tracker',
    token_address: 'mint',
    exit_at: partial.entry_at,
    status: 'closed',
    is_simulated: true,
    features: null,
    created_at: partial.entry_at ?? '2026-07-01T00:00:00.000Z',
    ...partial,
  }
}

describe('resolveReportTimeZone', () => {
  it('defaults to Asia/Bangkok', () => {
    expect(resolveReportTimeZone(null)).toBe('Asia/Bangkok')
    expect(resolveReportTimeZone('Garbage/Zone')).toBe('Asia/Bangkok')
  })
  it('accepts UTC and Bangkok', () => {
    expect(resolveReportTimeZone('UTC')).toBe('UTC')
    expect(resolveReportTimeZone('Asia/Bangkok')).toBe('Asia/Bangkok')
  })
})

describe('hourInTimeZone', () => {
  it('maps UTC noon to Bangkok 19:00', () => {
    // 12:00 UTC = 19:00 Asia/Bangkok (UTC+7)
    expect(hourInTimeZone('2026-07-01T12:00:00.000Z', 'UTC')).toBe(12)
    expect(hourInTimeZone('2026-07-01T12:00:00.000Z', 'Asia/Bangkok')).toBe(19)
  })
})

describe('computeBestTradeWindows', () => {
  it('picks the 4h window with highest avg pnl (UTC)', () => {
    // Cluster 5 trades at hours 10–13 with high pnl; noise elsewhere
    const rows: StrategyOutcomeRow[] = []
    for (let i = 0; i < 5; i++) {
      rows.push(
        outcome({
          id: `hi-${i}`,
          strategy_id: 'mcap_enter_at_80',
          pnl_pct: 50,
          entry_at: `2026-07-01T${String(10 + (i % 4)).padStart(2, '0')}:15:00.000Z`,
        }),
      )
    }
    for (let i = 0; i < 5; i++) {
      rows.push(
        outcome({
          id: `lo-${i}`,
          strategy_id: 'mcap_enter_at_80',
          pnl_pct: -10,
          entry_at: `2026-07-01T0${i}:30:00.000Z`,
        }),
      )
    }

    const [section] = computeBestTradeWindows(rows, { timeZone: 'UTC' })
    expect(section?.best).not.toBeNull()
    expect(section?.best?.start_hour).toBe(10)
    expect(section?.best?.end_hour).toBe(14)
    expect(section?.best?.avg_pnl_pct).toBeGreaterThan(40)
    expect(section?.timezone).toBe('UTC')
  })

  it('returns null best when fewer than 5 timed trades', () => {
    const rows = [
      outcome({
        id: '1',
        strategy_id: 'att',
        domain: 'trending_bot',
        pnl_pct: 100,
        entry_at: '2026-07-01T08:00:00.000Z',
      }),
      outcome({
        id: '2',
        strategy_id: 'att',
        domain: 'trending_bot',
        pnl_pct: 80,
        entry_at: '2026-07-01T09:00:00.000Z',
      }),
    ]
    const [section] = computeBestTradeWindows(rows, { timeZone: 'UTC' })
    expect(section?.best).toBeNull()
    expect(section?.top_windows).toHaveLength(0)
  })

  it('wraps midnight windows', () => {
    const rows: StrategyOutcomeRow[] = []
    // hours 22,23,0,1 — all high
    for (const h of [22, 23, 0, 1, 22]) {
      rows.push(
        outcome({
          id: `w-${h}-${rows.length}`,
          strategy_id: 'wrap',
          pnl_pct: 30,
          entry_at: `2026-07-01T${String(h).padStart(2, '0')}:00:00.000Z`,
        }),
      )
    }
    const [section] = computeBestTradeWindows(rows, { timeZone: 'UTC' })
    expect(section?.best?.start_hour).toBe(22)
    expect(section?.best?.end_hour).toBe(2)
  })

  it('separates SIM and LIVE', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        outcome({
          id: `s-${i}`,
          strategy_id: 'x',
          pnl_pct: 40,
          is_simulated: true,
          entry_at: `2026-07-01T1${i % 4}:00:00.000Z`,
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        outcome({
          id: `l-${i}`,
          strategy_id: 'x',
          pnl_pct: -5,
          is_simulated: false,
          entry_at: `2026-07-01T0${i}:00:00.000Z`,
        }),
      ),
    ]
    const sections = computeBestTradeWindows(rows, { timeZone: 'UTC' })
    expect(sections).toHaveLength(2)
    const sim = sections.find((s) => s.is_simulated)
    const live = sections.find((s) => !s.is_simulated)
    expect(sim?.best?.avg_pnl_pct).toBeGreaterThan(0)
    expect(live?.best?.avg_pnl_pct ?? 0).toBeLessThanOrEqual(0)
  })

  it('formatHourRangeLabel is readable', () => {
    expect(formatHourRangeLabel(14, 18, 'Asia/Bangkok')).toContain('14:00–18:00')
    expect(formatHourRangeLabel(14, 18, 'Asia/Bangkok')).toContain('Bangkok')
  })
})
