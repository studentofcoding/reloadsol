import { describe, expect, it } from 'vitest'
import {
  closeOutcomeStatusFromPnl,
  summarizeClosedPnls,
  telegramCloseStatusLabel,
} from './close-outcome-status'

describe('close outcome status', () => {
  it('maps flat pnl to breakeven, not won', () => {
    expect(closeOutcomeStatusFromPnl(0)).toBe('breakeven')
    expect(closeOutcomeStatusFromPnl(1e-12)).toBe('breakeven')
    expect(closeOutcomeStatusFromPnl(-1e-12)).toBe('breakeven')
    expect(closeOutcomeStatusFromPnl(Number.NaN)).toBe('breakeven')
  })

  it('keeps won strictly positive and lost strictly negative', () => {
    expect(closeOutcomeStatusFromPnl(0.01)).toBe('won')
    expect(closeOutcomeStatusFromPnl(-0.01)).toBe('lost')
  })

  it('telegram label shows BREAKEVEN for a flat even if status was won', () => {
    expect(telegramCloseStatusLabel(0, 'won')).toBe('breakeven')
    expect(telegramCloseStatusLabel(0)).toBe('breakeven')
    expect(telegramCloseStatusLabel(4.2, 'won')).toBe('won')
    expect(telegramCloseStatusLabel(-3, 'lost')).toBe('lost')
  })
})

describe('summarizeClosedPnls win%', () => {
  it('excludes flats from the win numerator', () => {
    const summary = summarizeClosedPnls([10, 0, 0, -5, 1e-12])
    expect(summary).toEqual({
      winCount: 1,
      lossCount: 1,
      breakevenCount: 3,
      winRate: 1 / 5,
    })
  })

  it('does not treat entry=exit (pnl 0) as a win', () => {
    const summary = summarizeClosedPnls([0, 0, 12])
    expect(summary.winCount).toBe(1)
    expect(summary.winRate).toBeCloseTo(1 / 3)
  })
})
