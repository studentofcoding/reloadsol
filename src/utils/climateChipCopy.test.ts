import { describe, expect, it } from 'vitest'
import {
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
    expect(climateChipHeadline('Not safe')).toBe('Caution')
    expect(climateChipHeadline('Safe')).toBe('Regime OK')
    expect(climateChipHeadline('Unknown')).toBe('Regime …')
  })

  it('makes only Not safe cautionary', () => {
    const tip = climateChipTip({
      label: 'Not safe',
      state: 'De-risk',
      cascadeVeto: true,
    })
    expect(tip).toMatch(/Caution/i)
    expect(tip).toMatch(/cascade risk/i)
    expect(tip).toMatch(/still allowed/i)
    expect(climateChipSubtitle({ label: 'Not safe', state: 'De-risk', h: 0.45 })).toBe(
      'De-risk · H 0.45',
    )
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
