import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
}))

import { query } from '@/utils/db'
import { parseEarlyEnterNoulTokenPeakSort } from './early-enter-noul-shadow'
import {
  loadEarlyEnterNoulShadowTokenPeaks,
  resetEarlyEnterNoulShadowDbEnsureForTests,
} from './early-enter-noul-shadow-db'

const queryMock = vi.mocked(query)

function summaryRow(
  partial: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    grouping_band: 1,
    grouping_arm: 1,
    first_band: null,
    first_arm: null,
    unique_mints: 3,
    with_peak: 2,
    median_peak: 80,
    avg_peak: 90,
    hit_100: 1,
    at80_avg_peak: 150,
    at80_with_peak: 1,
    at80_mints: 1,
    ...partial,
  }
}

describe('parseEarlyEnterNoulTokenPeakSort', () => {
  it('defaults to peak desc and ignores unknown sorts', () => {
    expect(parseEarlyEnterNoulTokenPeakSort(null)).toBe('peak_desc')
    expect(parseEarlyEnterNoulTokenPeakSort('peak_asc')).toBe('peak_asc')
    expect(parseEarlyEnterNoulTokenPeakSort('predicted_desc')).toBe('predicted_desc')
    expect(parseEarlyEnterNoulTokenPeakSort('drop table')).toBe('peak_desc')
  })
})

describe('loadEarlyEnterNoulShadowTokenPeaks', () => {
  beforeEach(() => {
    resetEarlyEnterNoulShadowDbEnsureForTests()
    queryMock.mockReset()
  })

  it('maps unique-mint peaks, fills empty bands, and leaves a missing peak null', async () => {
    const sqlSeen: string[] = []
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      sqlSeen.push(sql)
      if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('GROUP BY GROUPING SETS')) {
        return {
          rowCount: 3,
          rows: [
            summaryRow(),
            summaryRow({
              grouping_band: 0,
              grouping_arm: 1,
              first_band: 'keep',
              unique_mints: 2,
              with_peak: 2,
              median_peak: '125',
              avg_peak: 125,
              hit_100: 1,
            }),
            summaryRow({
              grouping_band: 1,
              grouping_arm: 0,
              first_arm: 'at_80',
              unique_mints: 1,
              with_peak: 1,
              median_peak: 150,
              avg_peak: 150,
              hit_100: 1,
              at80_avg_peak: 150,
              at80_with_peak: 1,
              at80_mints: 1,
            }),
          ],
        }
      }
      expect(params).toEqual([100, 0])
      return {
        rowCount: 2,
        rows: [
          {
            token_address: '82ezhRLKdKwkSC9jkM3js1yf93VbmvLXNMPkBmompump',
            symbol: 'PEAK',
            chain: 'sol',
            first_predicted_at: new Date('2026-09-01T00:00:00.000Z'),
            latest_predicted_at: new Date('2026-09-02T00:00:00.000Z'),
            first_band: 'keep',
            first_decision_shadow: 'keep',
            first_decision_spec: 'suppress',
            first_strategy_key: 'mcap_enter_at_80',
            first_cl_ml_score: 0.4,
            avg_cl_ml_score: '0.55',
            noul: 0.81,
            peak_growth_percent: 150,
          },
          {
            token_address: 'NoPeakMint',
            symbol: null,
            chain: 'sol',
            first_predicted_at: '2026-09-03T00:00:00.000Z',
            latest_predicted_at: '2026-09-03T01:00:00.000Z',
            first_band: 'suppress',
            first_decision_shadow: 'suppress',
            first_decision_spec: 'suppress',
            first_strategy_key: 'mcap_enter_first_seen',
            first_cl_ml_score: null,
            avg_cl_ml_score: null,
            noul: null,
            peak_growth_percent: null,
          },
        ],
      }
    })

    const result = await loadEarlyEnterNoulShadowTokenPeaks()

    expect(result.uniqueMints).toBe(3)
    expect(result.total).toBe(3)
    expect(result.withPeak).toBe(2)
    expect(result.medianPeakPercent).toBe(80)
    expect(result.hit100).toBe(1)
    expect(result.hit100Rate).toBe(0.5)
    expect(result.at80AvgPeakPercent).toBe(150)
    expect(result.at80WithPeak).toBe(1)
    expect(result.at80Mints).toBe(1)
    expect(result.sort).toBe('peak_desc')
    expect(result.byFirstBand.map((row) => row.band)).toEqual([
      'suppress',
      'keep',
      'mid',
      'skipped_null',
      'api_miss',
    ])
    expect(result.byFirstBand.find((row) => row.band === 'keep')).toMatchObject({
      uniqueMints: 2,
      medianPeakPercent: 125,
      hit100Rate: 0.5,
    })
    expect(result.byFirstBand.find((row) => row.band === 'mid')).toMatchObject({
      uniqueMints: 0,
      withPeak: 0,
      hit100Rate: null,
    })
    expect(result.byFirstArm.find((row) => row.arm === 'at_80')).toMatchObject({
      uniqueMints: 1,
      avgPeakPercent: 150,
    })
    expect(result.byFirstArm.find((row) => row.arm === 'first_seen')).toMatchObject({
      uniqueMints: 0,
    })
    expect(result.mints).toEqual([
      {
        tokenAddress: '82ezhRLKdKwkSC9jkM3js1yf93VbmvLXNMPkBmompump',
        symbol: 'PEAK',
        chain: 'sol',
        firstPredictedAt: '2026-09-01T00:00:00.000Z',
        latestPredictedAt: '2026-09-02T00:00:00.000Z',
        firstBand: 'keep',
        firstDecisionShadow: 'keep',
        firstDecisionSpec: 'suppress',
        avgClMlScore: 0.55,
        firstClMlScore: 0.4,
        noul: 0.81,
        peakGrowthPercent: 150,
        arm: 'at_80',
        firstStrategyKey: 'mcap_enter_at_80',
      },
      {
        tokenAddress: 'NoPeakMint',
        symbol: null,
        chain: 'sol',
        firstPredictedAt: '2026-09-03T00:00:00.000Z',
        latestPredictedAt: '2026-09-03T01:00:00.000Z',
        firstBand: 'suppress',
        firstDecisionShadow: 'suppress',
        firstDecisionSpec: 'suppress',
        avgClMlScore: null,
        firstClMlScore: null,
        noul: null,
        peakGrowthPercent: null,
        arm: 'first_seen',
        firstStrategyKey: 'mcap_enter_first_seen',
      },
    ])

    const reads = sqlSeen.filter((sql) => !sql.includes('CREATE '))
    expect(reads).toHaveLength(2)
    for (const sql of reads) {
      expect(sql).toContain('LEFT JOIN token_mcap_tracking')
      expect(sql).toContain('peak_growth_percent')
      expect(sql).toContain("strategy_key LIKE '%at_80%'")
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i)
    }
    expect(reads[1]).toContain(
      'peak_growth_percent DESC NULLS LAST, latest_predicted_at DESC',
    )
  })

  it('clamps the page and whitelists the sort column', async () => {
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('LIMIT')) {
        expect(params).toEqual([500, 20])
        expect(sql).toContain('latest_predicted_at ASC, token_address ASC')
        expect(sql).not.toContain('not_a_column')
      }
      return {
        rowCount: 1,
        rows: sql.includes('GROUP BY GROUPING SETS') ? [summaryRow({ unique_mints: 0, with_peak: 0, hit_100: 0, median_peak: null, avg_peak: null, at80_avg_peak: null, at80_with_peak: 0, at80_mints: 0 })] : [],
      }
    })

    const result = await loadEarlyEnterNoulShadowTokenPeaks({
      limit: 9000,
      offset: 20,
      sort: 'predicted_asc',
    })
    expect(result.limit).toBe(500)
    expect(result.offset).toBe(20)
    expect(result.sort).toBe('predicted_asc')
    expect(result.hit100Rate).toBeNull()
  })

  it('returns an empty sample when the shadow table is missing', async () => {
    queryMock.mockRejectedValue(
      Object.assign(new Error('relation "early_enter_noul_shadow" does not exist'), {
        code: '42P01',
      }),
    )
    const result = await loadEarlyEnterNoulShadowTokenPeaks({ sort: 'peak_asc' })
    expect(result.uniqueMints).toBe(0)
    expect(result.mints).toEqual([])
    expect(result.total).toBe(0)
    expect(result.sort).toBe('peak_asc')
    expect(result.byFirstBand).toHaveLength(5)
  })
})
