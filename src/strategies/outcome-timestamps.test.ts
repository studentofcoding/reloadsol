import { describe, expect, it } from 'vitest'
import { coerceIsoTimestamp } from './outcome-timestamps'

describe('coerceIsoTimestamp', () => {
  it('turns JS Date#toString() GMT+0700 into UTC ISO', () => {
    expect(
      coerceIsoTimestamp('Wed Sep 02 2026 14:23:45 GMT+0700 (Indochina Time)'),
    ).toBe('2026-09-02T07:23:45.000Z')
    expect(
      coerceIsoTimestamp('Wed Sep  2 2026 14:23:45 GMT+0700 (Indochina Time)'),
    ).toBe('2026-09-02T07:23:45.000Z')
  })

  it('round-trips a Date and Date#toString() without shifting the instant', () => {
    const date = new Date('2026-09-02T07:23:45.000Z')
    expect(coerceIsoTimestamp(date)).toBe('2026-09-02T07:23:45.000Z')
    expect(coerceIsoTimestamp(date.toString())).toBe(date.toISOString())
  })

  it('keeps an existing ISO timestamp', () => {
    expect(coerceIsoTimestamp('2026-09-02T07:23:45.000Z')).toBe(
      '2026-09-02T07:23:45.000Z',
    )
  })

  it('does not treat a sliced Date#toString() prefix as a real day', () => {
    expect(coerceIsoTimestamp('Wed Sep 02')).toBeNull()
    expect(coerceIsoTimestamp('not-a-timestamp')).toBeNull()
    expect(coerceIsoTimestamp('')).toBeNull()
    expect(coerceIsoTimestamp(null)).toBeNull()
  })
})
