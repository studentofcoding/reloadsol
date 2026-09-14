import { describe, expect, it } from 'vitest'
import {
  NOT_SAFE_CHIP_TEXT,
  NOT_SAFE_CHIP_TEXT_COMPACT,
  climateChipHeadline,
  climateChipSubtitle,
  climateChipTip,
} from '@/utils/climateChipCopy'
import { climateChipLabel } from '@/utils/climateDisplay'

describe('climateChipHeadline / tip (presentation only)', () => {
  it('does not change the binary mapping', () => {
    expect(
      climateChipLabel({
        ok: true,
        stale: false,
        cascadeVeto: true,
        state: 'Hype',
      }),
    ).toBe('Not safe')
    expect(climateChipHeadline('Not safe')).toBe(
      'Beware: The current market is very risky',
    )
    expect(climateChipHeadline('Not safe')).toBe(NOT_SAFE_CHIP_TEXT)
    expect(climateChipHeadline('Not safe', 'compact')).toBe(
      NOT_SAFE_CHIP_TEXT_COMPACT,
    )
    expect(climateChipHeadline('Safe')).toBe('Regime OK')
    expect(climateChipHeadline('Unknown')).toBe('Regime …')
  })

  it('shows the exact Beware string on the chip and keeps De-risk/H in the tooltip only', () => {
    expect(climateChipHeadline('Not safe')).toBe(
      'Beware: The current market is very risky',
    )
    expect(
      climateChipSubtitle({ label: 'Not safe', state: 'De-risk', h: 0.48 }),
    ).toBeNull()

    const tip = climateChipTip({
      label: 'Not safe',
      state: 'De-risk',
      h: 0.48,
      cascadeVeto: true,
      sizeKind: 'trim',
      scale: 0.25,
      reason: 'cascade.veto caps ≤ trim',
    })
    expect(tip.startsWith('Beware: The current market is very risky.')).toBe(
      true,
    )
    expect(tip).toContain('De-risk')
    expect(tip).toContain('H 0.48')
    expect(tip).toContain('cascade veto')
    expect(tip).toContain('trim 0.25')
    expect(tip).toContain('cascade.veto caps ≤ trim')
    expect(tip).toContain('Trading is still allowed.')
  })

  it('keeps Safe calm and Unknown quiet', () => {
    expect(climateChipTip({ label: 'Safe', state: 'Range' })).toBe(
      'Regime OK (Range).',
    )
    expect(climateChipSubtitle({ label: 'Safe', state: 'Range', h: 0.4 })).toBe(
      'Range',
    )
    expect(climateChipTip({ label: 'Unknown' })).toBe(
      'Regime unavailable (fetch failed or stale).',
    )
    expect(climateChipSubtitle({ label: 'Unknown', state: 'Hype', h: 1 })).toBeNull()
  })
})
