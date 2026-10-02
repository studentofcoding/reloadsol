import { describe, expect, it } from 'vitest'
import {
  evaluateSltpPassHealth,
  SltpPassUnhealthyError,
} from '@/utils/sl-tp-pass-health'

const NO_ENV = {}

describe('evaluateSltpPassHealth', () => {
  it('healthy when everything is priced', () => {
    expect(evaluateSltpPassHealth({ positions: 40, stale: 0, failedChains: [] }, NO_ENV)).toEqual({
      ok: true,
      reason: null,
      staleRatio: 0,
    })
  })

  it('a thrown price fetch is unhealthy even with few positions', () => {
    const h = evaluateSltpPassHealth({ positions: 1, stale: 1, failedChains: ['sol'] }, NO_ENV)
    expect(h.ok).toBe(false)
    expect(h.reason).toContain('price fetch failed for chain(s) sol')
  })

  it('high stale ratio (>=50% of >=5 positions) is unhealthy', () => {
    const h = evaluateSltpPassHealth({ positions: 10, stale: 5, failedChains: [] }, NO_ENV)
    expect(h.ok).toBe(false)
    expect(h.staleRatio).toBe(0.5)
    expect(h.reason).toContain('5/10 positions unpriced')
  })

  it('a few legitimately unpriced tokens stay healthy', () => {
    expect(evaluateSltpPassHealth({ positions: 40, stale: 6, failedChains: [] }, NO_ENV).ok).toBe(true)
  })

  it('a tiny book is not judged on ratio (below the min-positions floor)', () => {
    expect(evaluateSltpPassHealth({ positions: 3, stale: 3, failedChains: [] }, NO_ENV).ok).toBe(true)
  })

  it('empty book is healthy', () => {
    expect(evaluateSltpPassHealth({ positions: 0, stale: 0, failedChains: [] }, NO_ENV).ok).toBe(true)
  })

  it('env knobs: ratio, min positions, 0 disables the ratio check but not fetch failures', () => {
    const tight = { SLTP_STALE_ALERT_RATIO: '0.1', SLTP_STALE_ALERT_MIN_POSITIONS: '2' }
    expect(evaluateSltpPassHealth({ positions: 10, stale: 1, failedChains: [] }, tight).ok).toBe(false)
    const off = { SLTP_STALE_ALERT_RATIO: '0' }
    expect(evaluateSltpPassHealth({ positions: 10, stale: 10, failedChains: [] }, off).ok).toBe(true)
    expect(evaluateSltpPassHealth({ positions: 10, stale: 10, failedChains: ['sol'] }, off).ok).toBe(false)
    const junk = { SLTP_STALE_ALERT_RATIO: 'x', SLTP_STALE_ALERT_MIN_POSITIONS: '-4' }
    expect(evaluateSltpPassHealth({ positions: 10, stale: 5, failedChains: [] }, junk).ok).toBe(false)
  })

  it('SltpPassUnhealthyError carries the reason and ratio', () => {
    const e = new SltpPassUnhealthyError('boom', 0.8)
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('SL/TP pass unhealthy: boom')
    expect(e.staleRatio).toBe(0.8)
  })
})
