import { describe, expect, it } from 'vitest'
import { climateChipLabel, toClimateChipPayload } from '@/utils/climateDisplay'
import {
  buildScoutBffResponse,
  canPaperNotchFromClimate,
  evaluateScoutRow,
  filterScoutRows,
  isPreferredCandidate,
  LIQ_FLOOR_USD,
  parseDataPublicFeed,
  paperNotchDisabledTip,
  type ScoutFeedRow,
} from '@/utils/data-public-scout'

function row(overrides: Partial<ScoutFeedRow> = {}): ScoutFeedRow {
  return {
    id: 1,
    ts: 1_000,
    kind: 'vetted',
    chain: 'robinhood',
    mint: '0xabc',
    symbol: 'ABC',
    name: 'Abc',
    decision: 'surfaced',
    score: 70,
    mcap: 50_000,
    liq: 20_000,
    ageMin: 40,
    source: 'new',
    vetoes: [],
    nameReuse: 0,
    ...overrides,
  }
}

describe('isPreferredCandidate', () => {
  it('keeps surfaced and run/revival kinds on both chains', () => {
    expect(isPreferredCandidate(row({ decision: 'surfaced' }))).toBe(true)
    expect(isPreferredCandidate(row({ decision: null, kind: 'rhrun' }))).toBe(true)
    expect(isPreferredCandidate(row({ decision: null, kind: 'rhrevival' }))).toBe(true)
    expect(
      isPreferredCandidate(row({ chain: 'solana', decision: 'surfaced', mint: 'SoMint' })),
    ).toBe(true)
    expect(
      isPreferredCandidate(row({ chain: 'solana', decision: null, kind: 'solrun' })),
    ).toBe(true)
  })

  it('rejects watching / vetoed / low score / missing decision without a run kind', () => {
    expect(isPreferredCandidate(row({ decision: 'watching' }))).toBe(false)
    expect(isPreferredCandidate(row({ decision: 'vetoed' }))).toBe(false)
    expect(isPreferredCandidate(row({ decision: 'low score' }))).toBe(false)
    expect(isPreferredCandidate(row({ decision: null, kind: 'vetted' }))).toBe(false)
    expect(isPreferredCandidate(row({ decision: null, kind: 'gradspike' }))).toBe(false)
  })
})

describe('evaluateScoutRow / filterScoutRows', () => {
  it('passes a surfaced row with empty vetoes and liq above the floor', () => {
    const out = evaluateScoutRow(row())
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.candidate.chain).toBe('robinhood')
      expect(out.candidate.mint).toBe('0xabc')
    }
  })

  it('fails non-empty / critical vetoes and keeps empty arrays', () => {
    expect(evaluateScoutRow(row({ vetoes: [] })).ok).toBe(true)
    const liqVeto = evaluateScoutRow(row({ vetoes: ['liquidity $1 < $9,000'] }))
    expect(liqVeto.ok).toBe(false)
    if (!liqVeto.ok) expect(liqVeto.reason).toBe('veto')
    const freeze = evaluateScoutRow(row({ vetoes: ['freeze authority ACTIVE'] }))
    expect(freeze.ok).toBe(false)
    if (!freeze.ok) expect(freeze.reason).toBe('veto')
    expect(evaluateScoutRow(row({ vetoes: 'bad' as unknown as string[] })).ok).toBe(false)
  })

  it('does not fail runs/revivals when vetoes and liq fields are absent', () => {
    const run = evaluateScoutRow(
      row({
        kind: 'rhrun',
        decision: null,
        vetoes: null,
        liq: null,
        nameReuse: null,
      }),
    )
    expect(run.ok).toBe(true)
  })

  it(`fails liq below ~$${LIQ_FLOOR_USD} when the field is present`, () => {
    const low = evaluateScoutRow(row({ liq: 8_999 }))
    expect(low.ok).toBe(false)
    if (!low.ok) expect(low.reason).toBe('liq')
    expect(evaluateScoutRow(row({ liq: 9_000 })).ok).toBe(true)
  })

  it('skips obvious ring / fresh / copycat only when those fields are present', () => {
    expect(
      evaluateScoutRow(row({ evmBundle: { verdict: 'ring', fresh: 2, n: 20 } })).ok,
    ).toBe(false)
    expect(
      evaluateScoutRow(
        row({ evmBundle: { verdict: 'clean', fresh: 14, n: 20 } }),
      ).ok,
    ).toBe(false)
    expect(
      evaluateScoutRow(row({ rhFreshWarn: { fresh: 14, of: 20 } })).ok,
    ).toBe(false)
    expect(evaluateScoutRow(row({ nameReuse: 8 })).ok).toBe(false)
    expect(evaluateScoutRow(row({ imageReuse: 2 })).ok).toBe(false)
    expect(
      evaluateScoutRow(row({ evmBundle: { verdict: 'clean', fresh: 2, n: 20 } })).ok,
    ).toBe(true)
    expect(evaluateScoutRow(row({ nameReuse: 1 })).ok).toBe(true)
  })

  it('dedupes by (chain, mint) and keeps the same mint on the other chain', () => {
    const { candidates } = filterScoutRows([
      row({ id: 1, mint: '0xabc', score: 80 }),
      row({ id: 2, mint: '0xABC', score: 90 }),
      row({
        id: 3,
        chain: 'solana',
        mint: '0xabc',
        decision: 'surfaced',
        score: 40,
      }),
      row({ id: 4, mint: '0xdef', decision: 'watching' }),
    ])
    expect(candidates.map((c) => `${c.chain}:${c.mint.toLowerCase()}`)).toEqual([
      'robinhood:0xabc',
      'solana:0xabc',
    ])
  })

  it('filters chain=solana vs chain=robinhood independently (same mode)', () => {
    const rows = [
      row({ chain: 'robinhood', mint: '0xrh' }),
      row({ chain: 'solana', mint: 'SoMint1' }),
    ]
    expect(filterScoutRows(rows, 'robinhood').candidates).toHaveLength(1)
    expect(filterScoutRows(rows, 'solana').candidates[0]?.chain).toBe('solana')
    expect(filterScoutRows(rows, 'all').candidates).toHaveLength(2)
  })
})

describe('climate gate on paper action', () => {
  it('allows paper notches only when the binary display label is Safe', () => {
    expect(canPaperNotchFromClimate('Safe')).toBe(true)
    expect(canPaperNotchFromClimate('Not safe')).toBe(false)
    expect(canPaperNotchFromClimate('Unknown')).toBe(false)
    expect(canPaperNotchFromClimate(null)).toBe(false)
    expect(paperNotchDisabledTip('Not safe')).toMatch(/Not safe/)
    expect(paperNotchDisabledTip('Unknown')).toMatch(/Unknown/)
  })

  it('maps Mixed/Range/Hype (no cascade) to Safe and Cash/cascade to blocked', () => {
    expect(
      canPaperNotchFromClimate(
        climateChipLabel({
          ok: true,
          stale: false,
          cascadeVeto: false,
          state: 'Mixed',
        }),
      ),
    ).toBe(true)
    expect(
      canPaperNotchFromClimate(
        climateChipLabel({
          ok: true,
          stale: false,
          cascadeVeto: false,
          state: 'Range',
        }),
      ),
    ).toBe(true)
    expect(
      canPaperNotchFromClimate(
        climateChipLabel({
          ok: true,
          stale: false,
          cascadeVeto: false,
          state: 'Hype',
        }),
      ),
    ).toBe(true)
    expect(
      canPaperNotchFromClimate(
        climateChipLabel({
          ok: true,
          stale: false,
          cascadeVeto: false,
          state: 'Cash',
        }),
      ),
    ).toBe(false)
    expect(
      canPaperNotchFromClimate(
        climateChipLabel({
          ok: true,
          stale: false,
          cascadeVeto: true,
          state: 'Hype',
        }),
      ),
    ).toBe(false)
    expect(
      canPaperNotchFromClimate(
        climateChipLabel({
          ok: false,
          error: 'fail',
          stale: false,
          cascadeVeto: false,
          state: 'Hype',
        }),
      ),
    ).toBe(false)
  })

  it('attaches climateAtEmit and paperAllowed on the BFF payload', () => {
    const climateAtEmit = toClimateChipPayload(
      {
        ok: true,
        fetchedAt: 1_000,
        computedAt: 1_000,
        state: 'Range',
        h: 0.4,
        cascadeVeto: false,
        sizeKind: 'neutral',
        scale: 0.75,
      },
      { now: 1_000 },
    )
    const body = buildScoutBffResponse({
      chain: 'all',
      rows: [row(), row({ mint: '0xdead', decision: 'watching' })],
      meta: {
        generatedAt: 1_000,
        solDelayMin: 15,
        windowH: 24,
        page: 1,
        pages: 1,
        upstreamCounts: { rows: 2 },
      },
      climateAtEmit,
    })
    expect(body.climateAtEmit.label).toBe('Safe')
    expect(body.paperAllowed).toBe(true)
    expect(body.rows).toHaveLength(1)
    expect(body.disclaimer).toMatch(/Study/)
    expect(body.solDelayMin).toBe(15)

    const blocked = buildScoutBffResponse({
      chain: 'all',
      rows: [row()],
      meta: body,
      climateAtEmit: { ...climateAtEmit, label: 'Not safe' },
    })
    expect(blocked.paperAllowed).toBe(false)
    expect(blocked.rows).toHaveLength(1)
  })
})

describe('parseDataPublicFeed', () => {
  it('reads rows + solDelayMin from the public JSON envelope', () => {
    const parsed = parseDataPublicFeed({
      generatedAt: 99,
      solDelayMin: 15,
      windowH: 24,
      page: 1,
      pages: 2,
      counts: { rows: 1, rh: 1 },
      rows: [row()],
    })
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.meta.solDelayMin).toBe(15)
    expect(parsed.meta.generatedAt).toBe(99)
  })
})
