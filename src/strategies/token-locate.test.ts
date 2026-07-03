import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('@/utils/jupiter-metadata', () => ({
  fetchTokenMetadataFromJupiter: vi.fn(),
  fetchJupiterV2SearchRaw: vi.fn(),
  fetchJupiterDatapiSearchRaw: vi.fn(),
}))

vi.mock('@/utils/jupiter-pools-test', () => ({
  searchTokenStats: vi.fn(),
}))

vi.mock('@/utils/jupiter-api', () => ({
  fetchJupiterPriceRaw: vi.fn(),
}))

vi.mock('./db', () => ({
  loadStrategyDefinitionRows: vi.fn(),
}))

vi.mock('./social/db', () => ({
  fetchSocialRollup: vi.fn(),
  fetchRecentSocialEvents: vi.fn(),
}))

import { query, queryOne } from '@/utils/db'
import {
  fetchJupiterDatapiSearchRaw,
  fetchJupiterV2SearchRaw,
  fetchTokenMetadataFromJupiter,
} from '@/utils/jupiter-metadata'
import { searchTokenStats } from '@/utils/jupiter-pools-test'
import { fetchJupiterPriceRaw } from '@/utils/jupiter-api'
import { loadStrategyDefinitionRows } from './db'
import { fetchRecentSocialEvents, fetchSocialRollup } from './social/db'
import { locateTokenByAddress } from './token-locate'

const MINT = 'So11111111111111111111111111111111111111112'

describe('locateTokenByAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadStrategyDefinitionRows).mockResolvedValue([])
    vi.mocked(fetchJupiterV2SearchRaw).mockResolvedValue([
      { id: MINT, symbol: 'SOL', mcap: 80_000_000_000, organicScore: 99 },
    ])
    vi.mocked(fetchTokenMetadataFromJupiter).mockResolvedValue({
      symbol: 'SOL',
      mcap: 80_000_000_000,
      organicScore: 99,
    })
    vi.mocked(fetchJupiterDatapiSearchRaw).mockResolvedValue([])
    vi.mocked(fetchJupiterPriceRaw).mockResolvedValue({
      [MINT]: { usdPrice: 142.5 },
    })
    vi.mocked(searchTokenStats).mockResolvedValue({
      basic: { address: MINT, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9 },
    })
    vi.mocked(fetchSocialRollup).mockResolvedValue(null)
    vi.mocked(fetchRecentSocialEvents).mockResolvedValue([])
    vi.mocked(queryOne).mockResolvedValue(null)
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('rejects invalid mint addresses', async () => {
    await expect(locateTokenByAddress('not-a-mint')).rejects.toThrow('Invalid token address')
  })

  it('returns found=true when mcap row exists with recordLabel', async () => {
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      if (sql.includes('token_mcap_tracking')) {
        return {
          token_address: MINT,
          token_symbol: 'SOL',
          label: 'potential',
          first_mcap: 100_000,
          current_mcap: 250_000,
          mcap_growth_percent: 150,
        }
      }
      return null
    })

    const result = await locateTokenByAddress(MINT)

    expect(result.found).toBe(true)
    expect(result.symbol).toBe('SOL')
    expect(result.locations.mcap?.present).toBe(true)
    expect(result.locations.mcap?.label).toBe('potential')

    const mcapSection = result.rawSections.find((s) => s.id === 'mcap-tracking')
    expect(mcapSection?.recordLabel).toBe('potential')
    expect(mcapSection?.label).toBe('Mcap Tracker')
    expect(mcapSection?.dataTier).toBe('internal')

    expect(result.strategyPresence.some((p) => p.domain === 'mcap_tracker')).toBe(true)
  })

  it('includes raw and normalized Jupiter sections', async () => {
    const result = await locateTokenByAddress(MINT)

    const jupiterV2Raw = result.rawSections.find((s) => s.id === 'jupiter-v2-raw')
    expect(jupiterV2Raw?.label).toBe('Jupiter Token API (raw)')
    expect(jupiterV2Raw?.dataTier).toBe('raw')

    const jupiterV2Norm = result.rawSections.find((s) => s.id === 'jupiter-v2-normalized')
    expect(jupiterV2Norm?.dataTier).toBe('jupiter_enriched')

    const jupiterPriceRaw = result.rawSections.find((s) => s.id === 'jupiter-price-raw')
    expect(jupiterPriceRaw?.dataTier).toBe('raw')

    expect(result.jupiterEnrichment?.symbol).toBe('SOL')
    expect(result.jupiterEnrichment?.priceUsd).toBe(142.5)
  })

  it('sets liveOnly when only Jupiter has data', async () => {
    const result = await locateTokenByAddress(MINT)

    expect(result.found).toBe(false)
    expect(result.liveOnly).toBe(true)
    expect(result.rawSections.some((s) => s.dataTier === 'raw')).toBe(true)
  })

  it('queries all indexed sources in parallel', async () => {
    await locateTokenByAddress(MINT)

    expect(fetchJupiterV2SearchRaw).toHaveBeenCalledWith(MINT)
    expect(fetchTokenMetadataFromJupiter).toHaveBeenCalledWith(MINT)
    expect(fetchJupiterDatapiSearchRaw).toHaveBeenCalledWith(MINT)
    expect(fetchJupiterPriceRaw).toHaveBeenCalledWith(MINT)
    expect(searchTokenStats).toHaveBeenCalledWith(MINT)
    expect(fetchSocialRollup).toHaveBeenCalledWith(MINT)
    expect(fetchRecentSocialEvents).toHaveBeenCalledWith(MINT, 20)
    expect(loadStrategyDefinitionRows).toHaveBeenCalled()
    expect(queryOne).toHaveBeenCalled()
    expect(query).toHaveBeenCalled()
  })
})
