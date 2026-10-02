import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_MAX_AGE_MS,
  candidatesAreFresh,
  newestScreenedAt,
} from '@/utils/dlmm/candidate-freshness'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('candidate freshness', () => {
  it('treats the production case — 35-day-old rows — as stale', () => {
    // real data: newest screened_at 2026-08-28, a dead screener
    const stale = [{ screened_at: '2026-08-28T08:20:46.115+07:00' }]
    expect(candidatesAreFresh(stale, NOW)).toBe(false)
  })

  it('accepts candidates inside the window', () => {
    expect(candidatesAreFresh([{ screened_at: ago(60_000) }], NOW)).toBe(true)
    expect(candidatesAreFresh([{ screened_at: ago(CANDIDATE_MAX_AGE_MS - 1) }], NOW)).toBe(true)
  })

  it('rejects exactly at and beyond the window', () => {
    expect(candidatesAreFresh([{ screened_at: ago(CANDIDATE_MAX_AGE_MS) }], NOW)).toBe(false)
    expect(candidatesAreFresh([{ screened_at: ago(CANDIDATE_MAX_AGE_MS + 1) }], NOW)).toBe(false)
  })

  it('uses the NEWEST row, not the first', () => {
    expect(
      candidatesAreFresh([{ screened_at: ago(90 * 24 * 3600_000) }, { screened_at: ago(60_000) }], NOW),
    ).toBe(true)
    expect(newestScreenedAt([{ screened_at: ago(90 * 24 * 3600_000) }, { screened_at: ago(60_000) }]))
      .toBe(NOW - 60_000)
  })

  it('fails closed when the age cannot be established', () => {
    expect(candidatesAreFresh([], NOW)).toBe(false)
    expect(candidatesAreFresh([{ screened_at: '' }], NOW)).toBe(false)
    expect(candidatesAreFresh([{ screened_at: 'not a date' }], NOW)).toBe(false)
    expect(candidatesAreFresh([{}], NOW)).toBe(false)
  })

  it('treats a future timestamp as clock skew, not freshness', () => {
    expect(candidatesAreFresh([{ screened_at: new Date(NOW + 3600_000).toISOString() }], NOW)).toBe(false)
  })
})
