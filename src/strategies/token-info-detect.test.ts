import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
}))

vi.mock('@/utils/gmgn-web-multi', () => ({
  enqueueGmgnWebLedgerMints: vi.fn(),
  markGmgnWebLedgerCaptured: vi.fn(),
  usesGmgnWebTokenInfo: vi.fn(() => false),
}))

vi.mock('@/utils/gmgn-snapshot-cache', () => ({
  getGmgnTokenSnapshotCached: vi.fn(),
}))

import { query } from '@/utils/db'
import {
  enqueueGmgnWebLedgerMints,
  markGmgnWebLedgerCaptured,
  usesGmgnWebTokenInfo,
} from '@/utils/gmgn-web-multi'
import { getGmgnTokenSnapshotCached } from '@/utils/gmgn-snapshot-cache'
import { evaluateConcentrationBan } from '@/strategies/concentration-ban'
import {
  captureTokenInfoDetectBatch,
  insertTokenInfoDetectIfAbsent,
  preferTokenInfoForSoftUse,
  TOKEN_INFO_DETECT_SOURCES,
  type TokenInfoDetectSource,
} from '@/strategies/token-info-detect'

const MINT = 'So11111111111111111111111111111111111111112'
const DETECTED = new Date('2026-09-27T12:00:00.000Z')

type DbRow = {
  id: string
  chain: string
  token_address: string
  detected_at: Date
  detecting_strategy: string
  source: string
  top10_hold_pct: number | null
  dev_hold_pct: number | null
  snipers_hold_pct: number | null
  sniper_wallet_count: number | null
  freeze_auth_active: boolean | null
  mint_auth_active: boolean | null
  dex_boost_label: string | null
  pro_traders_pct: number | null
  insiders_hold_pct: number | null
  bundlers_hold_pct: number | null
}

let stored: DbRow | null = null

function rowFromParams(params: unknown[]): DbRow {
  return {
    id: 'row-1',
    chain: String(params[0]),
    token_address: String(params[1]),
    detected_at: params[2] as Date,
    detecting_strategy: String(params[3]),
    source: String(params[4]),
    top10_hold_pct: params[5] as number | null,
    dev_hold_pct: params[6] as number | null,
    snipers_hold_pct: params[7] as number | null,
    sniper_wallet_count: params[8] as number | null,
    freeze_auth_active: params[9] as boolean | null,
    mint_auth_active: params[10] as boolean | null,
    dex_boost_label: params[11] as string | null,
    pro_traders_pct: params[12] as number | null,
    insiders_hold_pct: params[13] as number | null,
    bundlers_hold_pct: params[14] as number | null,
  }
}

describe('token_info_detect', () => {
  beforeEach(() => {
    stored = null
    vi.mocked(query).mockReset()
    vi.mocked(enqueueGmgnWebLedgerMints).mockReset()
    vi.mocked(markGmgnWebLedgerCaptured).mockReset()
    vi.mocked(usesGmgnWebTokenInfo).mockReset()
    vi.mocked(getGmgnTokenSnapshotCached).mockReset()
    vi.mocked(usesGmgnWebTokenInfo).mockReturnValue(false)
    vi.mocked(markGmgnWebLedgerCaptured).mockResolvedValue(undefined)
    vi.mocked(query).mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      expect(text).not.toContain('first_seen_at')
      expect(text).not.toContain('DO UPDATE')
      if (text.includes('INSERT INTO token_info_detect')) {
        expect(text).toContain('ON CONFLICT (chain, token_address) DO NOTHING')
        const next = rowFromParams(params ?? [])
        if (
          stored &&
          stored.chain === next.chain &&
          stored.token_address === next.token_address
        ) {
          return { rows: [], rowCount: 0 }
        }
        stored = next
        return { rows: [stored], rowCount: 1 }
      }
      if (text.includes('FROM token_info_detect')) {
        const chain = params?.[0]
        const address = params?.[1]
        if (stored && stored.chain === chain && stored.token_address === address) {
          return { rows: [stored], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`unexpected sql: ${text}`)
    })
  })

  it('inserts null tiles and keeps the seam clock', async () => {
    const result = await insertTokenInfoDetectIfAbsent({
      chain: 'sol',
      tokenAddress: MINT,
      detectingStrategy: 'mcap_enter_first_seen',
      source: 'mcap_first_seen',
      detectedAt: DETECTED,
      info: { note: 'panel' },
      security: { renounced_mint: false },
    })
    expect(result.inserted).toBe(true)
    expect(result.row?.detectedAt).toBe(DETECTED.toISOString())
    expect(result.row?.snapshot.top10HoldPct).toBeNull()
    expect(result.row?.snapshot.mintAuthActive).toBe(true)
    expect(stored?.detected_at).toEqual(DETECTED)
  })

  it('does not insert an empty panel and does not overwrite the winner', async () => {
    await insertTokenInfoDetectIfAbsent({
      chain: 'sol',
      tokenAddress: MINT,
      detectingStrategy: 'social_only_fomo_gt7',
      source: 'social',
      detectedAt: DETECTED,
      info: {},
      security: {},
    })
    expect(stored).toBeNull()

    await captureTokenInfoDetectBatch([
      {
        chain: 'sol',
        tokenAddress: MINT,
        detectingStrategy: 'mcap_enter_first_seen',
        source: 'mcap_first_seen',
        detectedAt: DETECTED,
        info: { stat: { top_10_holder_rate: 0.1 } },
        security: { bundler_trader_amount_rate: 0.2 },
      },
    ])
    const firstTop10 = stored?.top10_hold_pct

    const lost = await insertTokenInfoDetectIfAbsent({
      chain: 'sol',
      tokenAddress: MINT,
      detectingStrategy: 'gmgn_smartmoney_default',
      source: 'gmgn_pipeline',
      detectedAt: new Date('2026-09-27T18:00:00.000Z'),
      info: { stat: { top_10_holder_rate: 0.9 } },
      security: { bundler_trader_amount_rate: 0.9 },
    })
    expect(lost.inserted).toBe(false)
    expect(lost.row?.snapshot.top10HoldPct).toBe(firstTop10)
    expect(lost.row?.detectingStrategy).toBe('mcap_enter_first_seen')
    expect(stored?.top10_hold_pct).toBe(firstTop10)
    expect(stored?.detected_at).toEqual(DETECTED)
  })

  it('prefers the ledger and does not overlay a live panel', async () => {
    await captureTokenInfoDetectBatch([
      {
        chain: 'sol',
        tokenAddress: MINT,
        detectingStrategy: 'trending_default',
        source: 'trending',
        detectedAt: DETECTED,
        info: { stat: { top_10_holder_rate: 0.1, creator_hold_rate: 0.02 } },
        security: { bundler_trader_amount_rate: 0.03 },
      },
    ])
    const soft = await preferTokenInfoForSoftUse({
      chain: 'sol',
      tokenAddress: MINT,
      live: {
        top10HoldPct: 90,
        devHoldPct: 90,
        snipersHoldPct: 90,
        sniperWalletCount: 9,
        freezeAuthActive: true,
        mintAuthActive: true,
        dexBoostLabel: 'live',
        proTradersPct: 90,
        insidersHoldPct: 90,
        bundlersHoldPct: 90,
      },
    })
    expect(soft.from).toBe('ledger')
    expect(soft.snapshot?.top10HoldPct).toBeCloseTo(10, 5)
    expect(soft.snapshot?.bundlersHoldPct).toBeCloseTo(3, 5)
    expect(soft.snapshot?.dexBoostLabel).not.toBe('live')
  })

  it('returns the in-tick panel only when the row is absent', async () => {
    const missing = await preferTokenInfoForSoftUse({
      chain: 'sol',
      tokenAddress: MINT,
    })
    expect(missing).toEqual({ snapshot: null, from: 'absent' })

    const live = await preferTokenInfoForSoftUse({
      chain: 'sol',
      tokenAddress: MINT,
      live: {
        top10HoldPct: 12,
        devHoldPct: null,
        snipersHoldPct: null,
        sniperWalletCount: null,
        freezeAuthActive: null,
        mintAuthActive: null,
        dexBoostLabel: null,
        proTradersPct: null,
        insidersHoldPct: null,
        bundlersHoldPct: null,
      },
    })
    expect(live.from).toBe('live')
    expect(live.snapshot?.top10HoldPct).toBe(12)
  })

  it('does not capture robinhood or an empty openapi fetch', async () => {
    await captureTokenInfoDetectBatch([
      {
        chain: 'robinhood',
        tokenAddress: MINT,
        detectingStrategy: 'mcap_enter_first_seen_rh',
        source: 'mcap_first_seen',
      },
    ])
    expect(query).not.toHaveBeenCalled()
    expect(enqueueGmgnWebLedgerMints).not.toHaveBeenCalled()

    vi.mocked(getGmgnTokenSnapshotCached).mockResolvedValue(undefined)
    await captureTokenInfoDetectBatch([
      {
        chain: 'sol',
        tokenAddress: MINT,
        detectingStrategy: 'social_only_fomo_gt7',
        source: 'social',
      },
    ])
    expect(getGmgnTokenSnapshotCached).toHaveBeenCalledWith('sol', MINT)
    expect(stored).toBeNull()
  })

  it('uses the web ledger queue and marks capture only when the insert wins', async () => {
    vi.mocked(usesGmgnWebTokenInfo).mockReturnValue(true)
    vi.mocked(enqueueGmgnWebLedgerMints).mockResolvedValue([
      {
        address: MINT,
        info: { stat: { top_10_holder_rate: 0.25 } },
        security: { bundler_trader_amount_rate: 0.1 },
      },
    ])
    await captureTokenInfoDetectBatch([
      {
        chain: 'sol',
        tokenAddress: MINT,
        detectingStrategy: 'gmgn_smartmoney_default',
        source: 'gmgn_pipeline',
        detectedAt: DETECTED,
        info: { stat: { top_10_holder_rate: 0.99 } },
        security: { bundler_trader_amount_rate: 0.99 },
      },
    ])
    expect(enqueueGmgnWebLedgerMints).toHaveBeenCalledWith([MINT])
    expect(getGmgnTokenSnapshotCached).not.toHaveBeenCalled()
    expect(markGmgnWebLedgerCaptured).toHaveBeenCalledTimes(1)
    expect(stored?.top10_hold_pct).toBeCloseTo(25, 5)

    vi.mocked(markGmgnWebLedgerCaptured).mockClear()
    await captureTokenInfoDetectBatch([
      {
        chain: 'sol',
        tokenAddress: MINT,
        detectingStrategy: 'gmgn_kol_momentum',
        source: 'gmgn_pipeline',
        info: { stat: { top_10_holder_rate: 0.99 } },
        security: {},
      },
    ])
    expect(markGmgnWebLedgerCaptured).not.toHaveBeenCalled()
    expect(stored?.detecting_strategy).toBe('gmgn_smartmoney_default')
    expect(stored?.top10_hold_pct).toBeCloseTo(25, 5)
  })

  it('does not invent a numeric soft threshold and leaves the live ban alone', () => {
    expect(TOKEN_INFO_DETECT_SOURCES).toEqual([
      'mcap_first_seen',
      'mcap_at_80',
      'social',
      'gmgn_pipeline',
      'trending',
    ] satisfies TokenInfoDetectSource[])
    const ban = evaluateConcentrationBan({
      top10HoldPct: 65.1,
      devHoldPct: 0,
      bundlersHoldPct: 0,
    })
    expect(ban.ban).toBe(true)
    expect(
      evaluateConcentrationBan({
        top10HoldPct: 65,
        devHoldPct: 65,
        bundlersHoldPct: 65,
      }).ban,
    ).toBe(false)
  })

  it('ships write-once DDL and no upsert path', () => {
    const sql = readFileSync('db/init/42-token-info-detect.sql', 'utf8')
    expect(sql).toContain('UNIQUE (chain, token_address)')
    expect(sql).toContain('token_info_detect_history')
    expect(sql).toContain('ON DELETE RESTRICT')
    expect(sql).not.toContain('UPDATE token_info_detect')
    expect(sql).not.toContain('ON CONFLICT')
  })
})
