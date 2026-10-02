import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn() }))
vi.mock('@/utils/dexscreener-volume', () => ({ fetchDexScreenerVolumeHints: vi.fn() }))
vi.mock('@/utils/mcap-tracker', () => ({ upsertMcapEntryMeta: vi.fn() }))
vi.mock('@/strategies/resolve-entry-snapshot', () => ({ fetchJupiterEntryHints: vi.fn() }))

import { query } from '@/utils/db'
import { fetchDexScreenerVolumeHints } from '@/utils/dexscreener-volume'
import { upsertMcapEntryMeta } from '@/utils/mcap-tracker'
import { fetchJupiterEntryHints } from '@/strategies/resolve-entry-snapshot'
import { backfillMcapEntryMeta } from './mcap-entry-meta-backfill'

const SOL_A = 'So11111111111111111111111111111111111111112'
const SOL_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

beforeEach(() => {
  vi.mocked(query).mockReset()
  vi.mocked(fetchJupiterEntryHints).mockReset()
  vi.mocked(fetchDexScreenerVolumeHints).mockReset()
  vi.mocked(upsertMcapEntryMeta).mockReset()
  vi.mocked(fetchDexScreenerVolumeHints).mockResolvedValue(null)
})

describe('backfillMcapEntryMeta', () => {
  it('is sol-only — the query is chain-scoped, not parameterised', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never)

    await backfillMcapEntryMeta({ sinceDays: 7, limit: 50 })

    const [sql] = vi.mocked(query).mock.calls[0]!
    expect(String(sql)).toContain("chain = 'sol'")
    // No chain argument to pass a non-sol value through.
    expect(String(sql)).not.toContain('$3')
  })

  it('writes only rows that actually have hints, and counts the rest as empty', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ token_address: SOL_A }, { token_address: SOL_B }],
      rowCount: 2,
    } as never)
    vi.mocked(fetchJupiterEntryHints).mockImplementation(async (addr: string) =>
      addr === SOL_A
        ? { organicScore: 62, topHoldersPct: 21, volume5m: 11896, mcap: 46844, volumeWindow: null }
        : { organicScore: null, topHoldersPct: null, volume5m: null, mcap: null, volumeWindow: null },
    )

    const result = await backfillMcapEntryMeta({ sinceDays: 7, limit: 50 })

    expect(result).toMatchObject({ candidates: 2, filled: 1, empty: 1, failed: 0, dryRun: false })
    expect(vi.mocked(upsertMcapEntryMeta)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(upsertMcapEntryMeta)).toHaveBeenCalledWith(SOL_A, {
      organicScore: 62,
      topHoldersPct: 21,
      volume5m: 11896,
    })
  })

  it('falls back to DexScreener for volume when Jupiter has none', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ token_address: SOL_A }], rowCount: 1 } as never)
    vi.mocked(fetchJupiterEntryHints).mockResolvedValue({
      organicScore: null,
      topHoldersPct: null,
      volume5m: null,
      mcap: null,
      volumeWindow: null,
    })
    vi.mocked(fetchDexScreenerVolumeHints).mockResolvedValue({ volume: 4200, window: '5m' } as never)

    const result = await backfillMcapEntryMeta({ sinceDays: 7, limit: 50 })

    expect(result.filled).toBe(1)
    expect(vi.mocked(upsertMcapEntryMeta)).toHaveBeenCalledWith(SOL_A, {
      organicScore: null,
      topHoldersPct: null,
      volume5m: 4200,
    })
  })

  it('dry-run resolves hints but writes nothing', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ token_address: SOL_A }], rowCount: 1 } as never)
    vi.mocked(fetchJupiterEntryHints).mockResolvedValue({
      organicScore: 62,
      topHoldersPct: 21,
      volume5m: 100,
      mcap: null,
      volumeWindow: null,
    })

    const result = await backfillMcapEntryMeta({ dryRun: true })

    expect(result).toMatchObject({ filled: 1, dryRun: true })
    expect(vi.mocked(upsertMcapEntryMeta)).not.toHaveBeenCalled()
  })

  it('counts a thrown hint lookup as failed without aborting the run', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ token_address: SOL_A }, { token_address: SOL_B }],
      rowCount: 2,
    } as never)
    vi.mocked(fetchJupiterEntryHints)
      .mockRejectedValueOnce(new Error('upstream down'))
      .mockResolvedValueOnce({
        organicScore: 20,
        topHoldersPct: 5,
        volume5m: 1,
        mcap: null,
        volumeWindow: null,
      })

    const result = await backfillMcapEntryMeta({})

    expect(result).toMatchObject({ candidates: 2, filled: 1, failed: 1 })
  })
})
