import { describe, expect, it } from 'vitest'
import { composeRiskLabel, riskLabelChip, riskLabelLines } from '@/strategies/risk-label'
import { mapRugcheckReport } from '@/strategies/rugcheck-features'
import { scoreDevReputation } from '@/strategies/dev-reputation'

const rugcheck = mapRugcheckReport({
  mint: 'm',
  score_normalised: 43,
  creatorBalance: 0,
  risks: [{ name: 'Single holder ownership', score: 5006 }],
  graphInsidersDetected: 2,
})
const dev = scoreDevReputation({ innerCount: 3529, openCount: 29 })

describe('risk label', () => {
  it('suffixes every rendered line with (shadow)', () => {
    const label = composeRiskLabel({ rugcheck, dev, shadow: true })
    const lines = riskLabelLines(label)
    expect(lines.length).toBe(2)
    expect(lines.every((l) => l.endsWith('(shadow)'))).toBe(true)
  })

  it('carries the dev verdict through', () => {
    const label = composeRiskLabel({ rugcheck, dev, shadow: true })
    expect(label.verdict).toBe('ban')
  })

  it('tones a ban red and shows shadow in the chip', () => {
    const label = composeRiskLabel({ rugcheck, dev, shadow: true })
    const chip = riskLabelChip(label)
    expect(chip?.tone).toBe('red')
    expect(chip?.text).toContain('(shadow)')
    expect(chip?.text).toContain('dev ban')
  })

  it('drops the shadow suffix in enforce mode', () => {
    const label = composeRiskLabel({ rugcheck, dev, shadow: false })
    expect(riskLabelLines(label).every((l) => !l.includes('shadow'))).toBe(true)
  })

  it('returns no chip when nothing is available', () => {
    const label = composeRiskLabel({ rugcheck: null, dev: null, shadow: true })
    expect(label.reasons).toEqual([])
    expect(riskLabelChip(label)).toBeNull()
  })
})
