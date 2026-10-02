import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn() }))
vi.mock('./db', () => ({
  loadConsensusTest: vi.fn(),
  loadPaperCapital: vi.fn(),
}))

import { query } from '@/utils/db'
import { loadConsensusTest, loadPaperCapital } from './db'
import {
  loadReportPrecompute,
  refreshReportPrecompute,
  reportPrecomputeKey,
  reportPrecomputeTargets,
} from './report-precompute'

const mockQuery = vi.mocked(query)
const mockConsensus = vi.mocked(loadConsensusTest)
const mockCapital = vi.mocked(loadPaperCapital)

const consensus = {
  buckets: [],
  lifts: [],
  min_tokens_per_bucket: 30,
  samples: 2000,
  seed: 1,
}
const capital = { chain: 'sol', currency: 'SOL' } as never

beforeEach(() => {
  mockQuery.mockReset()
  mockConsensus.mockReset()
  mockCapital.mockReset()
  mockConsensus.mockResolvedValue(consensus as never)
  mockCapital.mockResolvedValue(capital)
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
})

describe('reportPrecomputeKey', () => {
  it('defaults the absent dimensions to "all" so a stored row maps to a filter shape', () => {
    expect(reportPrecomputeKey({ chain: 'sol' })).toBe(
      'report-precompute:v1:sol:all:all:Asia/Bangkok',
    )
  })

  it('keeps domain, sim and timezone distinct', () => {
    expect(
      reportPrecomputeKey({
        chain: 'robinhood',
        domain: 'mcap_tracker',
        isSimulated: false,
        timeZone: 'UTC',
      }),
    ).toBe('report-precompute:v1:robinhood:mcap_tracker:false:UTC')
  })
})

describe('reportPrecomputeTargets', () => {
  it('covers both chains, every domain plus all, and both timezones — uniquely', () => {
    const targets = reportPrecomputeTargets()
    // 2 chains x (6 domains + 'all') x 2 timezones.
    expect(targets).toHaveLength(28)
    const keys = targets.map((t) => reportPrecomputeKey(t))
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('report-precompute:v1:sol:all:all:Asia/Bangkok')
    expect(keys).toContain('report-precompute:v1:robinhood:social:all:UTC')
  })
})

describe('loadReportPrecompute', () => {
  it('returns the stored payload with its computed_at', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          payload: JSON.stringify({ consensus, capital: [capital] }),
          computed_at: '2026-09-30T12:00:00.000Z',
        },
      ],
      rowCount: 1,
    } as never)
    const row = await loadReportPrecompute('k')
    expect(row?.consensus).toEqual(consensus)
    expect(row?.computed_at).toBe('2026-09-30T12:00:00.000Z')
  })

  it('returns null when nothing is stored or the table is missing', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    expect(await loadReportPrecompute('k')).toBeNull()

    // Missing table = the worker has never run: the report computes live instead.
    mockQuery.mockRejectedValue(
      new Error('relation "strategy_report_precompute" does not exist'),
    )
    expect(await loadReportPrecompute('k')).toBeNull()
  })
})

describe('refreshReportPrecompute', () => {
  it('upserts every target and reports the run', async () => {
    const run = await refreshReportPrecompute()
    expect(run.keys).toBe(28)
    expect(run.upserted).toBe(28)
    expect(run.failed).toBe(0)
    expect(run.errors).toEqual([])
    // consensus for the filters, capital for the chain — the same loaders the report uses.
    expect(mockConsensus).toHaveBeenCalledTimes(28)
    expect(mockCapital).toHaveBeenCalledTimes(28)
  })

  it('keeps going when one target fails, so a stale row beats no row', async () => {
    mockConsensus.mockRejectedValueOnce(new Error('boom'))
    const run = await refreshReportPrecompute()
    expect(run.failed).toBe(1)
    expect(run.upserted).toBe(27)
    expect(run.errors[0]).toContain('boom')
  })
})
