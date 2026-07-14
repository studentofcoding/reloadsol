import { describe, expect, it } from 'vitest'
import { shouldSkipRadarTelegramForMcap } from './gmgn-radar-thread-sync'

describe('shouldSkipRadarTelegramForMcap', () => {
  it('skips when known mcap is below min', () => {
    expect(shouldSkipRadarTelegramForMcap(15_000, 20_000)).toBe(true)
  })

  it('allows when mcap is at or above min', () => {
    expect(shouldSkipRadarTelegramForMcap(20_000, 20_000)).toBe(false)
    expect(shouldSkipRadarTelegramForMcap(25_000, 20_000)).toBe(false)
  })

  it('allows when mcap is unknown; defaults min to 20k when unset', () => {
    expect(shouldSkipRadarTelegramForMcap(null, 20_000)).toBe(false)
    expect(shouldSkipRadarTelegramForMcap(0, 20_000)).toBe(false)
    expect(shouldSkipRadarTelegramForMcap(15_000, null)).toBe(true)
    expect(shouldSkipRadarTelegramForMcap(15_000, 0)).toBe(false)
  })
})
