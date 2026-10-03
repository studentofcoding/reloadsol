import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ meta: vi.fn(), risk: vi.fn() }))
vi.mock('@/utils/jupiter-metadata', async () => {
  const real = await vi.importActual<typeof import('@/utils/jupiter-metadata')>('@/utils/jupiter-metadata')
  return { ...real, fetchTokenMetadataFromJupiter: (...a: unknown[]) => mocks.meta(...a) }
})
vi.mock('./token-risk', async () => {
  const real = await vi.importActual<typeof import('./token-risk')>('./token-risk')
  return { ...real, fetchTokenRiskData: (...a: unknown[]) => mocks.risk(...a) }
})

import { JupiterUnavailableError } from '@/utils/jupiter-metadata'
import { assessTokenRisk } from './risk-assessment'

const token = {
  token_address: 'So11111111111111111111111111111111111111112',
  token_symbol: 'TKN',
  mcap: 400_000,
  price: 1,
  organic_score: 90,
  change_1h: 0.01,
}

beforeEach(() => {
  mocks.meta.mockReset()
  mocks.risk.mockReset()
  mocks.risk.mockResolvedValue({ success: false, error: 'no data' })
})

describe('assessTokenRisk vs Jupiter availability', () => {
  it('a 429/timeout is NOT read as "not graduated": no jupiter_metadata verdict, flagged unavailable', async () => {
    mocks.meta.mockRejectedValue(new JupiterUnavailableError('rate_limited', '429'))
    const r = await assessTokenRisk(token, { enableLogging: false })
    expect(r.assessmentMethod).not.toBe('jupiter_metadata')
    expect(r.jupiterDetails).toBeUndefined()
    expect(r.jupiterUnavailable).toBe(true)
    // graduation is unknown, so the graduated-token path (TokenRisk) is still consulted
    expect(mocks.risk).toHaveBeenCalledTimes(1)
  })

  it('"no such token on Jupiter" keeps the existing non-graduated verdict', async () => {
    mocks.meta.mockRejectedValue(new Error('Token not found: x'))
    const r = await assessTokenRisk(token, { enableLogging: false })
    expect(r.assessmentMethod).toBe('jupiter_metadata')
    expect(r.jupiterUnavailable).toBeUndefined()
    expect(mocks.risk).not.toHaveBeenCalled()
  })

  it('a graduated token (bondingCurve 100) still goes to TokenRisk', async () => {
    mocks.meta.mockResolvedValue({ bondingCurve: 100, organicScore: 80 })
    await assessTokenRisk(token, { enableLogging: false })
    expect(mocks.risk).toHaveBeenCalledTimes(1)
  })

  it('asks Jupiter for a 2-minute-fresh record (graduation must not lag by 10 minutes)', async () => {
    mocks.meta.mockResolvedValue({ bondingCurve: 40 })
    await assessTokenRisk(token, { enableLogging: false })
    expect(mocks.meta).toHaveBeenCalledWith(token.token_address, { maxAgeMs: 120_000 })
  })
})
