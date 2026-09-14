import { describe, expect, it } from 'vitest'
import { canPaperNotchFromClimate } from '@/utils/data-public-scout'
import {
  parsePaperNotches,
  tryAddPaperNotch,
  type PaperNotch,
} from '@/utils/paper-notch-store'

const candidate = {
  chain: 'robinhood' as const,
  mint: '0xabc',
  symbol: 'ABC',
  name: 'Abc',
  kind: 'vetted',
  decision: 'surfaced',
  score: 70,
}

describe('tryAddPaperNotch climate gate', () => {
  it('records a paper interest notch when climate display is Safe', () => {
    const result = tryAddPaperNotch([], candidate, { label: 'Safe', state: 'Range' }, 5_000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.notch.source).toBe('data-public')
      expect(result.notch.climateLabel).toBe('Safe')
      expect(result.notch.notedAt).toBe(5_000)
      expect(result.notches).toHaveLength(1)
    }
  })

  it('refuses new notches when climate is Not safe or Unknown (observe only)', () => {
    expect(tryAddPaperNotch([], candidate, { label: 'Not safe' }).ok).toBe(false)
    expect(tryAddPaperNotch([], candidate, { label: 'Unknown' }).ok).toBe(false)
    const blocked = tryAddPaperNotch([], candidate, { label: 'Not safe' })
    if (!blocked.ok) expect(blocked.reason).toBe('climate_not_safe')
    expect(canPaperNotchFromClimate('Not safe')).toBe(false)
  })

  it('does not execute trades — only appends a local interest record', () => {
    const result = tryAddPaperNotch([], candidate, { label: 'Safe' }, 1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.notch).not.toHaveProperty('signature')
      expect(result.notch).not.toHaveProperty('tx')
      expect(JSON.stringify(result.notch)).not.toMatch(/executeBulkBuy|swap/i)
    }
  })

  it('dedupes by (chain, mint)', () => {
    const first = tryAddPaperNotch([], candidate, { label: 'Safe' }, 1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = tryAddPaperNotch(first.notches, candidate, { label: 'Safe' }, 2)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe('duplicate')
  })
})

describe('parsePaperNotches', () => {
  it('round-trips persisted notches and drops junk', () => {
    const saved: PaperNotch[] = [
      {
        key: 'robinhood:0xabc',
        chain: 'robinhood',
        mint: '0xabc',
        symbol: 'ABC',
        name: 'Abc',
        kind: 'vetted',
        decision: 'surfaced',
        score: 70,
        notedAt: 9,
        climateLabel: 'Safe',
        climateState: 'Hype',
        climateAtEmitLabel: 'Safe',
        source: 'data-public',
      },
    ]
    expect(parsePaperNotches(saved)).toHaveLength(1)
    expect(parsePaperNotches([{ mint: 'nope' }, null, 'x'])).toEqual([])
  })
})
