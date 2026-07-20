import { describe, expect, it } from 'vitest'
import {
  peakPriceTimestampMs,
  POTENTIAL_MAX_MS,
  resolveCaptureWindowMs,
  resolveSignalOhlcWindow,
  toSignalOhlcStoreLabel,
} from '@/strategies/signal-ohlc-window'

const start = '2026-07-20T10:00:00.000Z'
const startMs = Date.parse(start)

describe('toSignalOhlcStoreLabel', () => {
  it('maps rugged → rug', () => {
    expect(toSignalOhlcStoreLabel('rugged')).toBe('rug')
    expect(toSignalOhlcStoreLabel('potential')).toBe('potential')
    expect(toSignalOhlcStoreLabel('watching')).toBeNull()
  })
})

describe('peakPriceTimestampMs', () => {
  it('picks max price in window', () => {
    const ts = peakPriceTimestampMs(
      [
        { timestamp: startMs + 60_000, price_usd: 1 },
        { timestamp: startMs + 120_000, price_usd: 3 },
        { timestamp: startMs + 180_000, price_usd: 2 },
      ],
      startMs,
      startMs + 600_000,
    )
    expect(ts).toBe(startMs + 120_000)
  })
})

describe('resolveSignalOhlcWindow potential', () => {
  const nowMs = startMs + 30 * 60_000

  it('uses peak first', () => {
    const w = resolveSignalOhlcWindow({
      label: 'potential',
      nowMs,
      ctx: {
        tracking_started_at: start,
        price_history: [
          { timestamp: startMs + 60_000, price_usd: 1 },
          { timestamp: startMs + 90_000, price_usd: 5 },
        ],
        when_reach_80pct: new Date(startMs + 30_000).toISOString(),
      },
    })
    expect(w.endReason).toBe('peak')
    expect(Date.parse(w.windowEndIso)).toBe(startMs + 90_000)
  })

  it('falls back 200→120→80', () => {
    const w = resolveSignalOhlcWindow({
      label: 'potential',
      nowMs,
      ctx: {
        tracking_started_at: start,
        when_reach_120pct: new Date(startMs + 200_000).toISOString(),
        when_reach_80pct: new Date(startMs + 100_000).toISOString(),
      },
    })
    expect(w.endReason).toBe('milestone_120')
  })

  it('caps at 10m', () => {
    const w = resolveSignalOhlcWindow({
      label: 'potential',
      nowMs: startMs + 60 * 60_000,
      ctx: { tracking_started_at: start },
    })
    expect(w.endReason).toBe('cap_10m')
    expect(Date.parse(w.windowEndIso) - startMs).toBe(10 * 60_000)
  })
})

describe('resolveCaptureWindowMs', () => {
  it('no track anchor → last 10m ending now', () => {
    const nowMs = startMs + 60 * 60_000
    const w = resolveCaptureWindowMs({}, 'potential', nowMs)
    expect(w.endReason).toBe('label_now')
    expect(w.endMs).toBe(nowMs)
    expect(w.startMs).toBe(nowMs - POTENTIAL_MAX_MS)
  })

  it('with tracking_started_at → track start..cap', () => {
    const nowMs = startMs + 30 * 60_000
    const w = resolveCaptureWindowMs(
      { tracking_started_at: start },
      'potential',
      nowMs,
    )
    expect(w.startMs).toBe(startMs)
    expect(w.endMs - startMs).toBe(POTENTIAL_MAX_MS)
    expect(w.endReason).toBe('cap_10m')
  })
})

describe('resolveSignalOhlcWindow rug', () => {
  it('uses status_changed_at when present', () => {
    const stop = new Date(startMs + 45 * 60_000).toISOString()
    const w = resolveSignalOhlcWindow({
      label: 'rug',
      nowMs: startMs + 60 * 60_000,
      ctx: {
        tracking_started_at: start,
        status_changed_at: stop,
      },
    })
    expect(w.endReason).toBe('status_changed')
    expect(w.windowEndIso).toBe(stop)
  })

  it('uses now when no status_changed', () => {
    const nowMs = startMs + 12 * 60_000
    const w = resolveSignalOhlcWindow({
      label: 'rug',
      nowMs,
      ctx: { first_seen_at: start },
    })
    expect(w.endReason).toBe('label_now')
    expect(Date.parse(w.windowEndIso)).toBe(nowMs)
  })
})
