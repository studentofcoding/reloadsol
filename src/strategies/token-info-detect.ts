import { query } from '@/utils/db'
import {
  enqueueGmgnWebLedgerMints,
  markGmgnWebLedgerCaptured,
  usesGmgnWebTokenInfo,
} from '@/utils/gmgn-web-multi'
import { getGmgnTokenSnapshotCached } from '@/utils/gmgn-snapshot-cache'
import { enqueueRiskShadow } from '@/strategies/risk-shadow-queue'
import { log } from '@/utils/unified-logger'
import {
  buildGmgnTokenSnapshot,
  type GmgnTokenSnapshot,
} from '@/strategies/gmgn-token-snapshot'

/**
 * Write-once Freeview Token Info ledger.
 * Soft readers prefer the row when it exists. The live concentration hard
 * ban does not use this module. No numeric soft thresholds live here.
 *
 * SPEC: docs/specs/SPEC-token-info-universal-ledger-v1.md
 */

export const TOKEN_INFO_DETECT_SOURCES = [
  'mcap_first_seen',
  'mcap_at_80',
  'social',
  'gmgn_pipeline',
  'trending',
] as const

export type TokenInfoDetectSource = (typeof TOKEN_INFO_DETECT_SOURCES)[number]

export type TokenInfoDetectCapture = {
  chain: string
  tokenAddress: string
  detectingStrategy: string
  source: TokenInfoDetectSource
  /** Tick time that selected the mint. Never `token_mcap_tracking.first_seen_at`. */
  detectedAt?: Date
  info?: Record<string, unknown>
  security?: Record<string, unknown>
}

export type TokenInfoDetectRow = {
  id: string
  chain: string
  tokenAddress: string
  detectedAt: string
  detectingStrategy: string
  source: string
  snapshot: GmgnTokenSnapshot
}

type TokenInfoDetectDbRow = {
  id: string
  chain: string
  token_address: string
  detected_at: Date | string
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

const INSERT_SQL = `
INSERT INTO token_info_detect (
  chain,
  token_address,
  detected_at,
  detecting_strategy,
  source,
  top10_hold_pct,
  dev_hold_pct,
  snipers_hold_pct,
  sniper_wallet_count,
  freeze_auth_active,
  mint_auth_active,
  dex_boost_label,
  pro_traders_pct,
  insiders_hold_pct,
  bundlers_hold_pct
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9,
  $10, $11, $12, $13, $14, $15
)
ON CONFLICT (chain, token_address) DO NOTHING
RETURNING
  id, chain, token_address, detected_at, detecting_strategy, source,
  top10_hold_pct, dev_hold_pct, snipers_hold_pct, sniper_wallet_count,
  freeze_auth_active, mint_auth_active, dex_boost_label,
  pro_traders_pct, insiders_hold_pct, bundlers_hold_pct
`

const SELECT_SQL = `
SELECT
  id, chain, token_address, detected_at, detecting_strategy, source,
  top10_hold_pct, dev_hold_pct, snipers_hold_pct, sniper_wallet_count,
  freeze_auth_active, mint_auth_active, dex_boost_label,
  pro_traders_pct, insiders_hold_pct, bundlers_hold_pct
FROM token_info_detect
WHERE chain = $1 AND token_address = $2
LIMIT 1
`

function asIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(value)
}

function mapRow(row: TokenInfoDetectDbRow): TokenInfoDetectRow {
  return {
    id: row.id,
    chain: row.chain,
    tokenAddress: row.token_address,
    detectedAt: asIso(row.detected_at),
    detectingStrategy: row.detecting_strategy,
    source: row.source,
    snapshot: {
      top10HoldPct: row.top10_hold_pct,
      devHoldPct: row.dev_hold_pct,
      snipersHoldPct: row.snipers_hold_pct,
      sniperWalletCount: row.sniper_wallet_count,
      freezeAuthActive: row.freeze_auth_active,
      mintAuthActive: row.mint_auth_active,
      dexBoostLabel: row.dex_boost_label,
      proTradersPct: row.pro_traders_pct,
      insidersHoldPct: row.insiders_hold_pct,
      bundlersHoldPct: row.bundlers_hold_pct,
    },
  }
}

function panelPresent(
  info: Record<string, unknown> | undefined,
  security: Record<string, unknown> | undefined,
): boolean {
  if (!info || !security) return false
  return Object.keys(info).length > 0 || Object.keys(security).length > 0
}

export async function tokenInfoDetectRowExists(
  chain: string,
  tokenAddress: string,
): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM token_info_detect WHERE chain = $1 AND token_address = $2 LIMIT 1`,
    [chain, tokenAddress.trim()],
  )
  return rows.length > 0
}

export async function getTokenInfoDetect(
  chain: string,
  tokenAddress: string,
): Promise<TokenInfoDetectRow | null> {
  const address = tokenAddress.trim()
  if (!chain || !address) return null
  const { rows } = await query<TokenInfoDetectDbRow>(SELECT_SQL, [chain, address])
  const row = rows[0]
  return row ? mapRow(row) : null
}

export async function insertTokenInfoDetectIfAbsent(params: {
  chain: string
  tokenAddress: string
  detectingStrategy: string
  source: TokenInfoDetectSource
  detectedAt: Date
  info: Record<string, unknown>
  security: Record<string, unknown>
}): Promise<{ inserted: boolean; row: TokenInfoDetectRow | null }> {
  if (!panelPresent(params.info, params.security)) {
    return { inserted: false, row: null }
  }
  const address = params.tokenAddress.trim()
  if (!address) return { inserted: false, row: null }
  const snapshot = buildGmgnTokenSnapshot(params.info, params.security)
  const { rows } = await query<TokenInfoDetectDbRow>(INSERT_SQL, [
    params.chain,
    address,
    params.detectedAt,
    params.detectingStrategy,
    params.source,
    snapshot.top10HoldPct,
    snapshot.devHoldPct,
    snapshot.snipersHoldPct,
    snapshot.sniperWalletCount,
    snapshot.freezeAuthActive,
    snapshot.mintAuthActive,
    snapshot.dexBoostLabel,
    snapshot.proTradersPct,
    snapshot.insidersHoldPct,
    snapshot.bundlersHoldPct,
  ])
  const won = rows[0]
  if (won) return { inserted: true, row: mapRow(won) }
  const existing = await getTokenInfoDetect(params.chain, address)
  return { inserted: false, row: existing }
}

/**
 * Soft read. When a detect row exists, its nine tiles win.
 * A live panel is used only while the row is absent, and it is not written here.
 * A missing row does not skip, ban, or size to zero. Thresholds stay TBD.
 */
export async function preferTokenInfoForSoftUse(params: {
  chain: string
  tokenAddress: string
  live?: GmgnTokenSnapshot | null
}): Promise<{
  snapshot: GmgnTokenSnapshot | null
  from: 'ledger' | 'live' | 'absent'
}> {
  const row = await getTokenInfoDetect(params.chain, params.tokenAddress)
  if (row) return { snapshot: row.snapshot, from: 'ledger' }
  if (params.live) return { snapshot: params.live, from: 'live' }
  return { snapshot: null, from: 'absent' }
}

function firstByMint(items: TokenInfoDetectCapture[]): TokenInfoDetectCapture[] {
  const seen = new Map<string, TokenInfoDetectCapture>()
  for (const item of items) {
    if (item.chain !== 'sol') continue
    const address = item.tokenAddress.trim()
    if (!address || seen.has(address)) continue
    seen.set(address, { ...item, chain: 'sol', tokenAddress: address })
  }
  return [...seen.values()]
}

async function captureOpenApi(item: TokenInfoDetectCapture): Promise<void> {
  let info = item.info
  let security = item.security
  if (!panelPresent(info, security)) {
    const cached = await getGmgnTokenSnapshotCached('sol', item.tokenAddress)
    if (!cached) return
    info = cached.info
    security = cached.security
  }
  if (!info || !security || !panelPresent(info, security)) return
  await insertTokenInfoDetectIfAbsent({
    chain: 'sol',
    tokenAddress: item.tokenAddress,
    detectingStrategy: item.detectingStrategy,
    source: item.source,
    detectedAt: item.detectedAt ?? new Date(),
    info,
    security,
  })
}

async function captureWeb(items: TokenInfoDetectCapture[]): Promise<void> {
  const rows = await enqueueGmgnWebLedgerMints(items.map((item) => item.tokenAddress))
  const byAddress = new Map<string, { info: Record<string, unknown>; security: Record<string, unknown> }>()
  for (const row of rows) {
    if (!row) continue
    byAddress.set(row.address, { info: row.info, security: row.security })
  }
  for (const item of items) {
    const row = byAddress.get(item.tokenAddress)
    if (!row || !panelPresent(row.info, row.security)) continue
    const result = await insertTokenInfoDetectIfAbsent({
      chain: 'sol',
      tokenAddress: item.tokenAddress,
      detectingStrategy: item.detectingStrategy,
      source: item.source,
      detectedAt: item.detectedAt ?? new Date(),
      info: row.info,
      security: row.security,
    })
    if (result.inserted) await markGmgnWebLedgerCaptured(item.tokenAddress)
  }
}

/**
 * Freeze the panel at first Sol detect. Robinhood is ignored.
 * Best-effort: a DB or upstream error logs and leaves the tick running.
 * An empty panel does not occupy the unique key.
 */
export async function captureTokenInfoDetectBatch(
  items: TokenInfoDetectCapture[],
): Promise<void> {
  const sol = firstByMint(items)
  if (sol.length === 0) return
  // Shadow risk is independent of the GMGN panel: enqueue up front so RugCheck
  // (free, keyless) still runs when GMGN is rate-limited. The dev verdict then
  // degrades to 'inconclusive' instead of blocking the whole write.
  for (const item of sol) {
    if (item.source === 'gmgn_pipeline') continue
    enqueueRiskShadow({
      chain: 'sol',
      tokenAddress: item.tokenAddress,
      info: item.info,
    })
  }
  try {
    if (usesGmgnWebTokenInfo('sol')) {
      await captureWeb(sol)
      return
    }
    for (const item of sol) {
      try {
        await captureOpenApi(item)
      } catch (error) {
        log.warn('token_detection', 'token_info_detect capture skipped a mint', {
          tokenAddress: item.tokenAddress,
          source: item.source,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } catch (error) {
    log.warn('token_detection', 'token_info_detect capture failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function captureTokenInfoDetect(item: TokenInfoDetectCapture): Promise<void> {
  await captureTokenInfoDetectBatch([item])
}
