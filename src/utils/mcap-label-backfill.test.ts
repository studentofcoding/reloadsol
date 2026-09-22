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

import {
  planMcapLabelBackfill,
  runMcapLabelBackfill,
} from './mcap-label-backfill'
import type { McapSnapshot } from './mcap-tracker'

function row(overrides: Partial<McapSnapshot> = {}): McapSnapshot {
  return {
    token_address: 'mint1',
    token_symbol: 'TEST',
    chain: 'sol',
    first_mcap: 100_000,
    current_mcap: 100_000,
    first_seen_at: '2026-09-01T00:00:00.000Z',
    last_updated_at: '2026-09-22T00:00:00.000Z',
    mcap_growth_percent: 0,
    when_reach_80pct: null,
    when_reach_120pct: null,
    when_reach_200pct: null,
    when_drop_40pct: null,
    when_drop_80pct: null,
    peak_mcap: 100_000,
    peak_growth_percent: 0,
    peak_seen_at: '2026-09-01T00:00:00.000Z',
    is_tracking_stuck: false,
    label: null,
    ...overrides,
  }
}

const NOW = '2026-09-22T04:00:00.000Z'

describe('planMcapLabelBackfill', () => {
  it('stamps drop_40 and labels rugged when growth is -45', () => {
    const record = row({ mcap_growth_percent: -45, label: null })
    const plan = planMcapLabelBackfill(record, NOW)
    expect(record.when_drop_40pct).toBe(NOW)
    expect(record.when_drop_80pct).toBeNull()
    expect(record.label).toBe('rugged')
    expect(plan.persist).toBe(true)
    expect(plan.capture).toBe(true)
  })

  it('sets a missing peak from positive growth and labels potential', () => {
    const record = row({
      label: null,
      peak_growth_percent: null,
      peak_mcap: null,
      peak_seen_at: null,
      mcap_growth_percent: 10,
      current_mcap: 110_000,
    })
    const plan = planMcapLabelBackfill(record, NOW)
    expect(record.peak_growth_percent).toBe(10)
    expect(record.peak_mcap).toBe(110_000)
    expect(record.label).toBe('potential')
    expect(plan.persist).toBe(true)
    expect(plan.capture).toBe(true)
  })

  it('does not overwrite traded_live when drop_80 is set', () => {
    const record = row({
      label: 'traded_live',
      mcap_growth_percent: -90,
      when_drop_40pct: '2026-09-01T00:00:00.000Z',
      when_drop_80pct: '2026-09-01T00:00:00.000Z',
      peak_growth_percent: 20,
    })
    const plan = planMcapLabelBackfill(record, NOW)
    expect(record.label).toBe('traded_live')
    expect(plan.persist).toBe(false)
    expect(plan.capture).toBe(false)
    expect(plan.labelChanged).toBe(false)
  })

  it('leaves an existing potential label unwritten but still marks OHLC capture', () => {
    const record = row({
      label: 'potential',
      peak_growth_percent: 40,
      mcap_growth_percent: 12,
    })
    const plan = planMcapLabelBackfill(record, NOW)
    expect(record.label).toBe('potential')
    expect(plan.labelChanged).toBe(false)
    expect(plan.persist).toBe(false)
    expect(plan.capture).toBe(true)
  })

  it('does not lower rugged when drops were cleared and peak is positive', () => {
    const record = row({
      label: 'rugged',
      peak_growth_percent: 100,
      mcap_growth_percent: 10,
      when_drop_40pct: null,
      when_drop_80pct: null,
    })
    const plan = planMcapLabelBackfill(record, NOW)
    expect(record.label).toBe('rugged')
    expect(plan.capture).toBe(true)
    expect(plan.labelChanged).toBe(false)
  })
})

describe('runMcapLabelBackfill', () => {
  it('dry-run writes nothing', async () => {
    const record = row({ mcap_growth_percent: -45, label: null })
    const updateRow = vi.fn()
    const captureOhlc = vi.fn()
    const countOhlcTotals = vi.fn(async () => ({ potential: 4, rug: 2 }))
    const counts = await runMcapLabelBackfill({
      rows: [record],
      dryRun: true,
      nowIso: NOW,
      updateRow,
      captureOhlc,
      countOhlcTotals,
    })
    expect(updateRow).not.toHaveBeenCalled()
    expect(captureOhlc).not.toHaveBeenCalled()
    expect(counts.label_updated).toBe(1)
    expect(counts.ohlc_captured).toBe(0)
    expect(counts.ohlc_potential_total).toBe(4)
    expect(counts.ohlc_rug_total).toBe(2)
    expect(record.label).toBe('rugged')
  })

  it('does not UPDATE an unchanged potential row but still captures OHLC', async () => {
    const record = row({
      label: 'potential',
      peak_growth_percent: 40,
      mcap_growth_percent: 12,
    })
    const updateRow = vi.fn()
    const captureOhlc = vi.fn(async () => 'existing' as const)
    const counts = await runMcapLabelBackfill({
      rows: [record],
      dryRun: false,
      nowIso: NOW,
      updateRow,
      captureOhlc,
    })
    expect(updateRow).not.toHaveBeenCalled()
    expect(captureOhlc).toHaveBeenCalledTimes(1)
    expect(counts.label_unchanged).toBe(1)
    expect(counts.ohlc_existing).toBe(1)
    expect(counts.ohlc_captured).toBe(0)
  })

  it('one OHLC failure does not abort the scan', async () => {
    const a = row({
      token_address: 'mintA',
      label: 'potential',
      peak_growth_percent: 5,
      mcap_growth_percent: 1,
    })
    const b = row({
      token_address: 'mintB',
      label: 'rugged',
      when_drop_40pct: '2026-09-01T00:00:00.000Z',
      peak_growth_percent: 80,
      mcap_growth_percent: -50,
    })
    const captureOhlc = vi.fn(async (record: McapSnapshot) => {
      if (record.token_address === 'mintA') throw new Error('ohlc down')
      return 'captured' as const
    })
    const counts = await runMcapLabelBackfill({
      rows: [a, b],
      dryRun: false,
      nowIso: NOW,
      updateRow: vi.fn(),
      captureOhlc,
    })
    expect(captureOhlc).toHaveBeenCalledTimes(2)
    expect(a.label).toBe('potential')
    expect(b.label).toBe('rugged')
    expect(counts.scanned).toBe(2)
    expect(counts.ohlc_failed).toBe(1)
    expect(counts.ohlc_captured).toBe(1)
  })
})
