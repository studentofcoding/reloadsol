import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn() }))
vi.mock('@/utils/gmgn-web-multi', () => ({
  enqueueGmgnWebLedgerMints: vi.fn(),
  markGmgnWebLedgerCaptured: vi.fn(),
  usesGmgnWebTokenInfo: vi.fn(() => true),
}))
vi.mock('@/utils/gmgn-snapshot-cache', () => ({ getGmgnTokenSnapshotCached: vi.fn() }))
vi.mock('@/strategies/risk-shadow-queue', () => ({ enqueueRiskShadow: vi.fn() }))

import { query } from '@/utils/db'
import { insertTokenInfoDetectIfAbsent } from '@/strategies/token-info-detect'
import { buildGmgnTokenSnapshot, missingCoreTiles } from '@/strategies/gmgn-token-snapshot'

const MINT = 'So11111111111111111111111111111111111111112'
const FULL_SECURITY = {
  top_10_holder_rate: 0.2,
  sniper_hold_rate: 0.01,
  bundler_trader_amount_rate: 0.03,
  renounced_mint: true,
  renounced_freeze_account: true,
}

const insertRow = {
  id: 'r1',
  chain: 'sol',
  token_address: MINT,
  detected_at: new Date(),
  detecting_strategy: 's',
  source: 'social',
  top10_hold_pct: 20,
  dev_hold_pct: null,
  snipers_hold_pct: 1,
  sniper_wallet_count: null,
  freeze_auth_active: false,
  mint_auth_active: false,
  dex_boost_label: null,
  pro_traders_pct: null,
  insiders_hold_pct: null,
  bundlers_hold_pct: 3,
}

describe('ledger core-tile gate', () => {
  beforeEach(() => {
    delete process.env.TOKEN_INFO_LEDGER_CORE_GATE
    vi.mocked(query).mockReset()
    vi.mocked(query).mockResolvedValue({ rows: [insertRow], rowCount: 1 } as never)
  })
  afterEach(() => {
    delete process.env.TOKEN_INFO_LEDGER_CORE_GATE
  })

  const base = {
    chain: 'sol',
    tokenAddress: MINT,
    detectingStrategy: 's',
    source: 'social' as const,
    detectedAt: new Date(),
  }

  it('refuses a partial panel (snipers + bundlers missing) — no INSERT, retryable', async () => {
    const r = await insertTokenInfoDetectIfAbsent({
      ...base,
      info: { stat: { top_10_holder_rate: 0.2 } },
      security: { renounced_mint: true, renounced_freeze_account: true },
    })
    expect(r).toEqual({ inserted: false, row: null, skipped: 'partial_panel' })
    expect(query).not.toHaveBeenCalled()
  })

  it('writes a complete panel', async () => {
    const r = await insertTokenInfoDetectIfAbsent({ ...base, info: { note: 'x' }, security: FULL_SECURITY })
    expect(r.inserted).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('TOKEN_INFO_LEDGER_CORE_GATE=off restores the old behavior', async () => {
    process.env.TOKEN_INFO_LEDGER_CORE_GATE = 'off'
    const r = await insertTokenInfoDetectIfAbsent({
      ...base,
      info: { note: 'x' },
      security: { renounced_mint: true },
    })
    expect(r.inserted).toBe(true)
  })

  it('missingCoreTiles lists exactly what is absent', () => {
    expect(missingCoreTiles(buildGmgnTokenSnapshot({}, FULL_SECURITY))).toEqual([])
    expect(missingCoreTiles(buildGmgnTokenSnapshot({}, {}))).toEqual([
      'top10HoldPct',
      'snipersHoldPct',
      'bundlersHoldPct',
      'freezeAuthActive',
      'mintAuthActive',
    ])
  })
})
