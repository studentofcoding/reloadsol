import { describe, expect, it } from 'vitest'
import { occurredMs } from './db'

/**
 * Regression guard for the rollup window bug: pg returns timestamptz as a JS
 * Date, so `event.occurred_at >= t30IsoString` was silently false and every
 * time-windowed rollup metric (mention_count_5m/30m, unique_channel_count_30m,
 * smart_wallet_buy_count_1h, top_source) was written as 0/null.
 */
describe('occurredMs', () => {
  const iso = '2026-09-28T05:45:00.000Z'

  it('parses a pg-returned Date', () => {
    expect(occurredMs(new Date(iso))).toBe(Date.parse(iso))
  })

  it('parses an ISO string', () => {
    expect(occurredMs(iso)).toBe(Date.parse(iso))
  })

  it('counts a mention 15m old inside the 30m window', () => {
    const nowMs = Date.parse('2026-09-28T06:00:00.000Z')
    const t30 = nowMs - 30 * 60 * 1000
    expect(occurredMs(new Date(iso)) >= t30).toBe(true)
  })

  it('excludes a mention older than the window', () => {
    const nowMs = Date.parse('2026-09-28T06:00:00.000Z')
    const t30 = nowMs - 30 * 60 * 1000
    expect(occurredMs('2026-09-28T05:00:00.000Z') >= t30).toBe(false)
  })

  it('documents why the ISO-string cutoff must not be compared directly', () => {
    // Date >= '…Z' coerces the string via Number() → NaN → always false.
    expect(Number(iso)).toBeNaN()
  })

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(occurredMs(null))).toBe(true)
    expect(Number.isNaN(occurredMs(undefined))).toBe(true)
  })
})
