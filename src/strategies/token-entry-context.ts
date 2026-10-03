/**
 * Entry-time context freeze: one insert-only `token_entry_context` row per Sol mint, written at the
 * first detect by ANY strategy (the same clock as the Token Info ledger, SPEC #91).
 *
 * What it freezes, and where each part comes from — none of it is a new GMGN call:
 *   - tracker first/current mcap  : `token_mcap_tracking` (mutable there; copied here)
 *   - live Jupiter mcap/price/vol : `fetchJupiterMarketHints` (shared L1/L2 cache + paced queue)
 *   - Token Info tiles            : copied from `token_info_detect` when that row already exists
 *   - last N 1m bars before detect: `token_ohlc_bars` (a 48 h rolling window — otherwise lost)
 *
 * Off unless `ENTRY_CONTEXT_FREEZE=1`. Best-effort and NEVER rejects: a failed part is recorded as a
 * status on the row ("tracker_status", "jup_status", "token_info_status") rather than blocking the
 * freeze, because the row is write-once and a retry would capture a different moment.
 *
 * SPEC: docs/specs/SPEC-entry-context-freeze-v1.md
 */
import { query } from '@/utils/db'
import { log } from '@/utils/unified-logger'
import { fetchJupiterMarketHints } from '@/utils/jupiter-metadata'

type EnvLike = Record<string, string | undefined>

export type EntryContextInput = {
  chain: 'sol'
  tokenAddress: string
  detectingStrategy: string
  source: string
  /** The seam's detect time. Bars are cut strictly before it. */
  detectedAt: Date
}

export type EntryBar = { t: string; o: number; h: number; l: number; c: number; v: number | null }

export type EntryContextResult =
  | { inserted: true }
  | { inserted: false; reason: 'disabled' | 'not_sol' | 'exists' | 'in_flight' | 'error' }

export function isEntryContextEnabled(env: EnvLike = process.env): boolean {
  return env.ENTRY_CONTEXT_FREEZE?.trim() === '1'
}

export function entryContextBarCount(env: EnvLike = process.env): number {
  const n = Number(env.ENTRY_CONTEXT_BARS)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 240) : 30
}

type Deps = {
  query: typeof query
  jupiter: typeof fetchJupiterMarketHints
  now: () => Date
  env: EnvLike
}

const inFlight = new Set<string>()

const EXISTS_SQL = `SELECT 1 AS one FROM token_entry_context WHERE chain = $1 AND token_address = $2 LIMIT 1`

const TRACKER_SQL = `
SELECT first_mcap, current_mcap, first_seen_at, label
  FROM token_mcap_tracking
 WHERE token_address = $1 AND chain = $2
 LIMIT 1`

const TILES_SQL = `
SELECT detected_at, detecting_strategy, source,
       top10_hold_pct, dev_hold_pct, snipers_hold_pct, sniper_wallet_count, freeze_auth_active,
       mint_auth_active, dex_boost_label, pro_traders_pct, insiders_hold_pct, bundlers_hold_pct
  FROM token_info_detect
 WHERE chain = $1 AND token_address = $2
 LIMIT 1`

const BARS_SQL = `
SELECT timestamp, open, high, low, close, volume
  FROM token_ohlc_bars
 WHERE token_address = $1 AND interval = '1m' AND timestamp < $2::timestamptz
 ORDER BY timestamp DESC
 LIMIT $3`

const INSERT_SQL = `
INSERT INTO token_entry_context (
  chain, token_address, detected_at, detecting_strategy, source, capture_lag_ms,
  tracker_first_mcap, tracker_current_mcap, tracker_first_seen_at, tracker_label, tracker_status,
  jup_mcap, jup_usd_price, jup_volume_5m, jup_fetched_at, jup_status,
  token_info, token_info_status,
  pre_entry_bars, pre_entry_bars_n, pre_entry_last_bar_at
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7, $8, $9, $10, $11,
  $12, $13, $14, $15, $16,
  $17::jsonb, $18,
  $19::jsonb, $20, $21
)
ON CONFLICT (chain, token_address) DO NOTHING
RETURNING id`

function num(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function iso(value: unknown): string | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

export function toEntryBars(
  rows: Array<{ timestamp: unknown; open: unknown; high: unknown; low: unknown; close: unknown; volume: unknown }>,
): EntryBar[] {
  return rows
    .map((r) => ({
      t: iso(r.timestamp) ?? '',
      o: num(r.open) ?? 0,
      h: num(r.high) ?? 0,
      l: num(r.low) ?? 0,
      c: num(r.close) ?? 0,
      v: num(r.volume),
    }))
    .filter((b) => b.t !== '')
    .reverse() // query is newest-first; the frozen array reads oldest-first
}

export async function freezeEntryContext(
  input: EntryContextInput,
  overrides: Partial<Deps> = {},
): Promise<EntryContextResult> {
  const deps: Deps = {
    query,
    jupiter: fetchJupiterMarketHints,
    now: () => new Date(),
    env: process.env,
    ...overrides,
  }
  if (!isEntryContextEnabled(deps.env)) return { inserted: false, reason: 'disabled' }
  if (input.chain !== 'sol') return { inserted: false, reason: 'not_sol' }
  const address = input.tokenAddress.trim()
  if (!address) return { inserted: false, reason: 'error' }
  if (inFlight.has(address)) return { inserted: false, reason: 'in_flight' }
  inFlight.add(address)
  try {
    // Cheap first-writer check so a second strategy's detect does no upstream work at all.
    const existing = await deps.query(EXISTS_SQL, [input.chain, address])
    if (existing.rows.length > 0) return { inserted: false, reason: 'exists' }

    const barCount = entryContextBarCount(deps.env)
    const jupiterOn = deps.env.ENTRY_CONTEXT_JUPITER?.trim().toLowerCase() !== 'off'
    const jupiterTimeoutMs = Number(deps.env.ENTRY_CONTEXT_JUPITER_TIMEOUT_MS) > 0
      ? Number(deps.env.ENTRY_CONTEXT_JUPITER_TIMEOUT_MS)
      : 4000

    const [tracker, tiles, bars, jup] = await Promise.all([
      deps.query(TRACKER_SQL, [address, input.chain]).then(
        (r) => ({ ok: true as const, row: r.rows[0] as Record<string, unknown> | undefined }),
        () => ({ ok: false as const, row: undefined }),
      ),
      deps.query(TILES_SQL, [input.chain, address]).then(
        (r) => ({ ok: true as const, row: r.rows[0] as Record<string, unknown> | undefined }),
        () => ({ ok: false as const, row: undefined }),
      ),
      deps.query(BARS_SQL, [address, input.detectedAt.toISOString(), barCount]).then(
        (r) => toEntryBars(r.rows as never),
        () => [] as EntryBar[],
      ),
      (async () => {
        if (!jupiterOn) return { status: 'disabled' as const, hints: null, at: null as Date | null }
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), jupiterTimeoutMs)
        })
        try {
          const res = await Promise.race([deps.jupiter(address), timeout])
          if (res === 'timeout') return { status: 'timeout' as const, hints: null, at: null }
          if (!res) return { status: 'unavailable' as const, hints: null, at: null }
          return { status: 'ok' as const, hints: res, at: deps.now() }
        } catch {
          return { status: 'unavailable' as const, hints: null, at: null }
        } finally {
          if (timer) clearTimeout(timer)
        }
      })(),
    ])

    const trackerRow = tracker.row
    const tileRow = tiles.row
    const tokenInfo = tileRow
      ? {
          ledger_detected_at: iso(tileRow.detected_at),
          ledger_detecting_strategy: tileRow.detecting_strategy,
          ledger_source: tileRow.source,
          top10HoldPct: num(tileRow.top10_hold_pct),
          devHoldPct: num(tileRow.dev_hold_pct),
          snipersHoldPct: num(tileRow.snipers_hold_pct),
          sniperWalletCount: num(tileRow.sniper_wallet_count),
          freezeAuthActive: tileRow.freeze_auth_active ?? null,
          mintAuthActive: tileRow.mint_auth_active ?? null,
          dexBoostLabel: tileRow.dex_boost_label ?? null,
          proTradersPct: num(tileRow.pro_traders_pct),
          insidersHoldPct: num(tileRow.insiders_hold_pct),
          bundlersHoldPct: num(tileRow.bundlers_hold_pct),
        }
      : null

    const nowMs = deps.now().getTime()
    const lagMs = Math.max(0, Math.min(2_147_483_647, nowMs - input.detectedAt.getTime()))
    const lastBar = bars.length > 0 ? bars[bars.length - 1].t : null

    const res = await deps.query(INSERT_SQL, [
      input.chain,
      address,
      input.detectedAt.toISOString(),
      input.detectingStrategy,
      input.source,
      lagMs,
      num(trackerRow?.first_mcap),
      num(trackerRow?.current_mcap),
      iso(trackerRow?.first_seen_at),
      (trackerRow?.label as string | null | undefined) ?? null,
      !tracker.ok ? 'error' : trackerRow ? 'ok' : 'absent',
      num(jup.hints?.mcap),
      num(jup.hints?.usdPrice),
      num(jup.hints?.volume5m),
      jup.at ? jup.at.toISOString() : null,
      jup.status,
      tokenInfo ? JSON.stringify(tokenInfo) : null,
      !tiles.ok ? 'error' : tokenInfo ? 'ledger' : 'absent',
      JSON.stringify(bars),
      bars.length,
      lastBar,
    ])
    return res.rows.length > 0 ? { inserted: true } : { inserted: false, reason: 'exists' }
  } catch (error) {
    log.warn('token_detection', 'token_entry_context freeze failed', {
      tokenAddress: address,
      source: input.source,
      error: error instanceof Error ? error.message : String(error),
    })
    return { inserted: false, reason: 'error' }
  } finally {
    inFlight.delete(address)
  }
}

export async function getEntryContext(
  chain: string,
  tokenAddress: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await query(
    `SELECT * FROM token_entry_context WHERE chain = $1 AND token_address = $2 LIMIT 1`,
    [chain, tokenAddress.trim()],
  )
  return (rows[0] as Record<string, unknown> | undefined) ?? null
}
