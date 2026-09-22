import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('@/utils/unified-logger', () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/strategies/signal-ohlc-labels', () => ({
  captureSignalOhlcLabel: vi.fn(),
}))

import { captureSignalOhlcLabel } from '@/strategies/signal-ohlc-labels'
import {
  applyAutoLabelsFromMilestones,
  applyMcapSessionUpdates,
  capturePendingMcapAutoLabelOhlc,
  reconcileMilestonesFromGrowth,
  resetTrackingSession,
  updatePeakMcap,
  type McapSnapshot,
} from './mcap-tracker'

function row(overrides: Partial<McapSnapshot> = {}): McapSnapshot {
  return {
    token_address: 'mint1',
    token_symbol: 'TEST',
    first_mcap: 100_000,
    current_mcap: 100_000,
    first_seen_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    last_updated_at: new Date().toISOString(),
    mcap_growth_percent: 0,
    when_reach_80pct: null,
    when_reach_120pct: null,
    when_reach_200pct: null,
    when_drop_40pct: null,
    when_drop_80pct: null,
    peak_mcap: 100_000,
    peak_growth_percent: 0,
    peak_seen_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    is_tracking_stuck: false,
    label: null,
    ...overrides,
  }
}

describe('updatePeakMcap', () => {
  it('raises peak when current exceeds prior peak', () => {
    const record = row({ peak_mcap: 100_000, peak_growth_percent: 0 })
    const now = new Date().toISOString()
    expect(updatePeakMcap(record, 150_000, 50, now)).toBe(true)
    expect(record.peak_mcap).toBe(150_000)
    expect(record.peak_growth_percent).toBe(50)
    expect(record.peak_seen_at).toBe(now)
  })

  it('does not lower peak on pullback', () => {
    const record = row({
      peak_mcap: 200_000,
      peak_growth_percent: 100,
      peak_seen_at: '2026-07-09T00:00:00.000Z',
    })
    expect(updatePeakMcap(record, 120_000, 20, new Date().toISOString())).toBe(false)
    expect(record.peak_mcap).toBe(200_000)
    expect(record.peak_growth_percent).toBe(100)
  })
})

describe('drop milestones + auto labels', () => {
  it('stamps -40 and -80 in one crash tick and labels rugged', () => {
    const record = row({ label: 'watching' })
    const now = new Date().toISOString()
    expect(applyMcapSessionUpdates(record, 15_000, -85, now)).toBe(true)
    expect(record.when_drop_40pct).toBe(now)
    expect(record.when_drop_80pct).toBe(now)
    expect(record.label).toBe('rugged')
  })

  it('labels potential when peak growth is positive', () => {
    const record = row({ label: 'valid', peak_growth_percent: 0 })
    const now = new Date().toISOString()
    applyMcapSessionUpdates(record, 140_000, 40, now)
    expect(record.peak_growth_percent).toBe(40)
    expect(record.label).toBe('potential')
  })

  it('does not overwrite traded_live with rugged or potential', () => {
    const record = row({ label: 'traded_live' })
    const now = new Date().toISOString()
    applyMcapSessionUpdates(record, 10_000, -90, now)
    expect(record.when_drop_80pct).toBe(now)
    expect(record.label).toBe('traded_live')
  })

  it('does not downgrade rugged to potential', () => {
    const record = row({
      label: 'rugged',
      when_drop_40pct: '2026-07-09T00:00:00.000Z',
      peak_mcap: 200_000,
      peak_growth_percent: 100,
    })
    expect(applyAutoLabelsFromMilestones(record)).toBe(false)
    expect(record.label).toBe('rugged')
  })

  it('reconcile backfills drop milestones from growth', () => {
    const record = row({ mcap_growth_percent: -45 })
    const t = new Date().toISOString()
    expect(reconcileMilestonesFromGrowth(record, t)).toBe(true)
    expect(record.when_drop_40pct).toBe(t)
    expect(record.when_drop_80pct).toBeNull()
  })

  it('labels watching with a positive peak as potential', () => {
    const record = row({ label: 'watching', peak_growth_percent: 1 })
    expect(applyAutoLabelsFromMilestones(record)).toBe(true)
    expect(record.label).toBe('potential')
  })

  it('promotes potential to rugged when a drop stamp is set', () => {
    const record = row({
      label: 'potential',
      peak_growth_percent: 40,
      when_drop_40pct: '2026-09-22T00:00:00.000Z',
    })
    expect(applyAutoLabelsFromMilestones(record)).toBe(true)
    expect(record.label).toBe('rugged')
  })

  it('keeps rugged when drops are cleared and peak is still positive', () => {
    const record = row({
      label: 'rugged',
      peak_growth_percent: 100,
      when_drop_40pct: null,
      when_drop_80pct: null,
    })
    expect(applyAutoLabelsFromMilestones(record)).toBe(false)
    expect(record.label).toBe('rugged')
  })

  it('leaves valid unchanged when peak and growth are zero', () => {
    const record = row({ label: 'valid', peak_growth_percent: 0, mcap_growth_percent: 0 })
    expect(applyAutoLabelsFromMilestones(record)).toBe(false)
    expect(record.label).toBe('valid')
  })

  it('reset clears drop and peak fields', () => {
    const record = row({
      when_drop_40pct: '2026-07-09T00:00:00.000Z',
      peak_mcap: 300_000,
      peak_growth_percent: 200,
    })
    const now = new Date().toISOString()
    resetTrackingSession(record, 50_000, now)
    expect(record.when_drop_40pct).toBeNull()
    expect(record.peak_mcap).toBe(50_000)
    expect(record.peak_growth_percent).toBe(0)
  })
})

describe('auto-label OHLC hook', () => {
  it('captures on a real transition and does not demote the tracker label when OHLC fails', async () => {
    vi.mocked(captureSignalOhlcLabel).mockRejectedValueOnce(new Error('empty bars'))
    const record = row({ label: 'watching', peak_growth_percent: 0 })
    const now = new Date().toISOString()
    applyMcapSessionUpdates(record, 110_000, 10, now)
    expect(record.label).toBe('potential')
    await capturePendingMcapAutoLabelOhlc(record)
    expect(record.label).toBe('potential')
    expect(captureSignalOhlcLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAddress: 'mint1',
        label: 'potential',
        source: 'mcap_auto_label',
      }),
    )
    await capturePendingMcapAutoLabelOhlc(record)
    expect(captureSignalOhlcLabel).toHaveBeenCalledTimes(1)
  })

  it('does not capture when the label did not change', async () => {
    vi.mocked(captureSignalOhlcLabel).mockClear()
    const record = row({
      label: 'potential',
      peak_mcap: 200_000,
      peak_growth_percent: 100,
    })
    applyMcapSessionUpdates(record, 150_000, 50, new Date().toISOString())
    expect(record.label).toBe('potential')
    await capturePendingMcapAutoLabelOhlc(record)
    expect(captureSignalOhlcLabel).not.toHaveBeenCalled()
  })

  it('captures rugged (not a second potential) when a potential row drops', async () => {
    vi.mocked(captureSignalOhlcLabel).mockResolvedValueOnce('ohlc-1')
    const record = row({
      token_address: 'mint-drop',
      label: 'potential',
      peak_growth_percent: 40,
      peak_mcap: 140_000,
    })
    const now = new Date().toISOString()
    applyMcapSessionUpdates(record, 50_000, -50, now)
    expect(record.label).toBe('rugged')
    await capturePendingMcapAutoLabelOhlc(record)
    expect(captureSignalOhlcLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAddress: 'mint-drop',
        label: 'rugged',
        source: 'mcap_auto_label',
      }),
    )
    expect(record.label).toBe('rugged')
  })
})
