import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LIQUIDITY_MIN_USD,
  DEFAULT_MCAP_MIN_USD,
  evaluateRecipeGates,
  resolveClimateChipLabel,
  resolveRecipeGates,
} from '@/utils/brain-gates'
import { climateChipLabel } from '@/utils/climateDisplay'

afterEach(() => {
  vi.unstubAllEnvs()
})

const MINT = 'So11111111111111111111111111111111111111112'

function passingToken(overrides: Record<string, unknown> = {}) {
  return {
    mint: MINT,
    marketCap: 80_000,
    liquidity: 20_000,
    score100: 10,
    freshWalletsPct: 80,
    top10AdjustedPct: 90,
    ...overrides,
  }
}

describe('resolveRecipeGates', () => {
  it('enables the default AND pack and leaves BM gates off', () => {
    const gates = resolveRecipeGates(undefined)
    expect(gates.filter((g) => g.enabled).map((g) => g.id)).toEqual([
      'membership',
      'mcap',
      'liquidity',
      'climateSafe',
    ])
    expect(gates.find((g) => g.id === 'bmScore')?.enabled).toBe(false)
    expect(gates.find((g) => g.id === 'bmFresh')?.enabled).toBe(false)
    expect(gates.find((g) => g.id === 'bmTop10')?.enabled).toBe(false)
    expect(gates.find((g) => g.id === 'mcap')?.min).toBe(DEFAULT_MCAP_MIN_USD)
    expect(gates.find((g) => g.id === 'liquidity')?.min).toBe(DEFAULT_LIQUIDITY_MIN_USD)
  })

  it('opts in bmScore when listed and can disable a default gate', () => {
    const gates = resolveRecipeGates([
      { id: 'mcap', enabled: false },
      { id: 'bmScore', min: 50 },
    ])
    expect(gates.find((g) => g.id === 'mcap')?.enabled).toBe(false)
    expect(gates.find((g) => g.id === 'membership')?.enabled).toBe(true)
    expect(gates.find((g) => g.id === 'bmScore')).toMatchObject({
      enabled: true,
      min: 50,
    })
  })
})

describe('evaluateRecipeGates default AND pack', () => {
  const universe = [MINT]
  const climate = { label: 'Safe' as const }

  it('passes when membership, mcap, liquidity, and Safe climate hold', () => {
    const result = evaluateRecipeGates({
      token: passingToken(),
      universeMints: universe,
      climate,
    })
    expect(result.pass).toBe(true)
    expect(result.rejectedBy).toEqual([])
  })

  it('rejects when mint is not on the universe list', () => {
    const result = evaluateRecipeGates({
      token: passingToken({ mint: 'otherMint' }),
      universeMints: universe,
      climate,
    })
    expect(result.pass).toBe(false)
    expect(result.rejectedBy).toContain('membership')
  })

  it('rejects mcap below the 50k floor', () => {
    const result = evaluateRecipeGates({
      token: passingToken({ marketCap: 49_999 }),
      universeMints: universe,
      climate,
    })
    expect(result.pass).toBe(false)
    expect(result.rejectedBy).toContain('mcap')
  })

  it('fails closed when marketCap is missing', () => {
    const result = evaluateRecipeGates({
      token: passingToken({ marketCap: null }),
      universeMints: universe,
      climate,
    })
    expect(result.pass).toBe(false)
    expect(result.rejectedBy).toContain('mcap')
    expect(result.reasons.some((r) => /missing/i.test(r))).toBe(true)
  })

  it('rejects liquidity below the 10k floor', () => {
    const result = evaluateRecipeGates({
      token: passingToken({ liquidity: 9_999 }),
      universeMints: universe,
      climate,
    })
    expect(result.pass).toBe(false)
    expect(result.rejectedBy).toContain('liquidity')
  })

  it('fails closed when liquidity is missing', () => {
    const result = evaluateRecipeGates({
      token: passingToken({ liquidity: undefined }),
      universeMints: universe,
      climate,
    })
    expect(result.pass).toBe(false)
    expect(result.rejectedBy).toContain('liquidity')
  })

  it('requires the climate chip Safe label', () => {
    const notSafe = evaluateRecipeGates({
      token: passingToken(),
      universeMints: universe,
      climate: 'Not safe',
    })
    const unknown = evaluateRecipeGates({
      token: passingToken(),
      universeMints: universe,
      climate: 'Unknown',
    })
    const missing = evaluateRecipeGates({
      token: passingToken(),
      universeMints: universe,
    })
    expect(notSafe.rejectedBy).toContain('climateSafe')
    expect(unknown.rejectedBy).toContain('climateSafe')
    expect(missing.rejectedBy).toContain('climateSafe')
  })

  it('maps interpret-style climate fields through the chip helper', () => {
    const safe = evaluateRecipeGates({
      token: passingToken(),
      universeMints: universe,
      climate: {
        ok: true,
        stale: false,
        cascadeVeto: false,
        state: 'Range',
      },
    })
    const veto = evaluateRecipeGates({
      token: passingToken(),
      universeMints: universe,
      climate: {
        ok: true,
        stale: false,
        cascadeVeto: true,
        state: 'Hype',
      },
    })
    expect(climateChipLabel({
      ok: true,
      stale: false,
      cascadeVeto: false,
      state: 'Range',
    })).toBe('Safe')
    expect(safe.pass).toBe(true)
    expect(veto.rejectedBy).toContain('climateSafe')
  })
})

describe('optional BM gates stay off by default', () => {
  const universe = [MINT]
  const climate = { label: 'Safe' as const }
  const weakBm = passingToken({
    score100: 10,
    freshWalletsPct: 90,
    top10AdjustedPct: 95,
  })

  it('does not reject on weak BM stats when BM gates are not opted in', () => {
    const result = evaluateRecipeGates({
      token: weakBm,
      universeMints: universe,
      climate,
    })
    expect(result.pass).toBe(true)
    expect(result.rejectedBy).toEqual([])
    expect(result.gates.filter((g) => g.optional && g.enabled)).toEqual([])
  })

  it('bmScore rejects when opted in and score100 is missing or not above N', () => {
    const missing = evaluateRecipeGates({
      token: passingToken({ score100: null }),
      universeMints: universe,
      climate,
      gates: [{ id: 'bmScore' }],
    })
    const low = evaluateRecipeGates({
      token: passingToken({ score100: 45 }),
      universeMints: universe,
      climate,
      gates: [{ id: 'bmScore' }],
    })
    const high = evaluateRecipeGates({
      token: passingToken({ score100: 46 }),
      universeMints: universe,
      climate,
      gates: [{ id: 'bmScore' }],
    })
    expect(missing.rejectedBy).toContain('bmScore')
    expect(low.rejectedBy).toContain('bmScore')
    expect(high.pass).toBe(true)
  })

  it('bmFresh and bmTop10 reject when opted in', () => {
    const fresh = evaluateRecipeGates({
      token: passingToken({ freshWalletsPct: 25 }),
      universeMints: universe,
      climate,
      gates: [{ id: 'bmFresh' }],
    })
    const top10 = evaluateRecipeGates({
      token: passingToken({ top10AdjustedPct: 40 }),
      universeMints: universe,
      climate,
      gates: [{ id: 'bmTop10' }],
    })
    const ok = evaluateRecipeGates({
      token: passingToken({ freshWalletsPct: 24, top10AdjustedPct: 39 }),
      universeMints: universe,
      climate,
      gates: [{ id: 'bmFresh' }, { id: 'bmTop10' }],
    })
    expect(fresh.rejectedBy).toContain('bmFresh')
    expect(top10.rejectedBy).toContain('bmTop10')
    expect(ok.pass).toBe(true)
  })
})

describe('resolveClimateChipLabel', () => {
  it('reads payload.label', () => {
    expect(resolveClimateChipLabel({ label: 'Safe' })).toBe('Safe')
  })
})
