import { query, queryOne } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import { cacheDelByPrefix, cacheGet, cacheSet } from '@/utils/redis-cache'
import {
  fetchTokenOhlc,
  getCachedTokenOhlc24h1m,
  tokenOhlcToRugBars,
} from '@/strategies/token-map-chart'
import { takeLastOhlcBars, type OhlcRugBar } from '@/strategies/ohlc-rug-rules'
import {
  POTENTIAL_MAX_MS,
  resolveCaptureWindowMs,
  toSignalOhlcStoreLabel,
  type SignalOhlcLabelKind,
  type TrackContext,
} from '@/strategies/signal-ohlc-window'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { isEvmTokenAddress } from '@/utils/gmgn-cli'

/**
 * Gallery cooldown marker after a failed soft backfill so list loads do not
 * hammer ST/GMGN every request. Soft overwrite / mcap --refill-empty still
 * replace these rows when real bars arrive.
 */
export const BACKFILL_EMPTY_SOURCE = 'backfill_empty'
const BACKFILL_CONCURRENCY = 3

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS signal_ohlc_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  token_symbol TEXT NULL,
  label TEXT NOT NULL
    CHECK (label IN ('potential', 'rug')),
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  ohlc_interval TEXT NOT NULL DEFAULT '1m'
    CHECK (ohlc_interval IN ('1m', '5m', '15m', '1h')),
  ohlc_source TEXT NOT NULL DEFAULT 'none',
  bars JSONB NOT NULL DEFAULT '[]'::jsonb,
  end_reason TEXT NULL,
  source TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signal_ohlc_labels_label_created
  ON signal_ohlc_labels (label, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_ohlc_labels_token_created
  ON signal_ohlc_labels (token_address, created_at DESC);
DELETE FROM signal_ohlc_labels sol
WHERE sol.id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY token_address, label
             ORDER BY created_at DESC
           ) AS rn
    FROM signal_ohlc_labels
  ) d
  WHERE d.rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_ohlc_labels_token_label
  ON signal_ohlc_labels (token_address, label);
`

/** Redis list cache TTL — 10 minutes */
export const SIGNAL_OHLC_LABELS_CACHE_TTL_SEC = 600

export function signalOhlcLabelsCachePrefix(
  label: SignalOhlcLabelKind,
): string {
  return `signal-ohlc-labels:v1:${label}`
}

export function signalOhlcLabelsCacheKey(
  label: SignalOhlcLabelKind,
  limit: number,
  offset: number,
): string {
  return `${signalOhlcLabelsCachePrefix(label)}:${limit}:${offset}`
}

async function invalidateSignalOhlcLabelsCache(
  label: SignalOhlcLabelKind,
): Promise<void> {
  await cacheDelByPrefix(signalOhlcLabelsCachePrefix(label))
}

let ensurePromise: Promise<void> | null = null

export async function ensureSignalOhlcLabelsTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = query(ENSURE_SQL)
      .then(() => undefined)
      .catch((err) => {
        ensurePromise = null
        throw err
      })
  }
  await ensurePromise
}

function trackerTable(): string {
  return process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'
}

async function loadTrackContext(
  tokenAddress: string,
): Promise<{ ctx: TrackContext; symbol: string | null }> {
  const tracker = trackerTable()
  const [trending, mcap] = await Promise.all([
    queryOne<Record<string, unknown>>(
      `SELECT token_symbol, tracking_started_at, waiting_started_at, created_at,
              status_changed_at, price_history
       FROM ${tracker}
       WHERE token_address = $1
       LIMIT 1`,
      [tokenAddress],
    ).catch(() => null),
    queryOne<Record<string, unknown>>(
      `SELECT token_symbol, first_seen_at, last_updated_at, peak_seen_at,
              when_reach_80pct, when_reach_120pct, when_reach_200pct
       FROM token_mcap_tracking
       WHERE token_address = $1
       LIMIT 1`,
      [tokenAddress],
    ).catch(() => null),
  ])

  const ctx: TrackContext = {
    tracking_started_at:
      (trending?.tracking_started_at as string | null) ?? null,
    waiting_started_at:
      (trending?.waiting_started_at as string | null) ?? null,
    first_seen_at: (mcap?.first_seen_at as string | null) ?? null,
    created_at: (trending?.created_at as string | null) ?? null,
    status_changed_at:
      (trending?.status_changed_at as string | null) ?? null,
    when_reach_80pct: (mcap?.when_reach_80pct as string | null) ?? null,
    when_reach_120pct: (mcap?.when_reach_120pct as string | null) ?? null,
    when_reach_200pct: (mcap?.when_reach_200pct as string | null) ?? null,
    price_history:
      (trending?.price_history as TrackContext['price_history']) ?? null,
  }

  if (
    (!ctx.price_history || ctx.price_history.length === 0) &&
    typeof mcap?.peak_seen_at === 'string'
  ) {
    ctx.price_history = [
      { timestamp: mcap.peak_seen_at, price_usd: 1 },
    ]
  }

  const symbol =
    (typeof trending?.token_symbol === 'string'
      ? trending.token_symbol
      : null) ??
    (typeof mcap?.token_symbol === 'string' ? mcap.token_symbol : null)

  return { ctx, symbol }
}

export type SignalOhlcLabelRow = {
  id: string
  token_address: string
  token_symbol: string | null
  label: SignalOhlcLabelKind
  window_start: string
  window_end: string
  ohlc_interval: string
  ohlc_source: string
  bars: Array<{ t: number; o: number; h: number; l: number; c: number; v?: number }>
  end_reason: string | null
  source: string | null
  created_at: string
}

function filterBarsToWindow(
  bars: OhlcRugBar[],
  startSec: number,
  endSec: number,
): OhlcRugBar[] {
  return bars.filter((b) => b.t >= startSec && b.t <= endSec)
}

export function rowBarsEmpty(
  row: Pick<SignalOhlcLabelRow, 'bars'> | { bars?: unknown },
): boolean {
  return !Array.isArray(row.bars) || row.bars.length === 0
}

/** Empty corpus slots (bars=[]) that soft overwrite / --refill-empty may refill. */
export function isEmptySignalOhlcSlot(
  row: Pick<SignalOhlcLabelRow, 'bars' | 'ohlc_source'> | { bars?: unknown },
): boolean {
  return rowBarsEmpty(row)
}

/**
 * Gallery list cooldown only: do not re-hit ST/GMGN on every page load after
 * one failed attempt (`backfill_empty`). This is not a UNIQUE lock.
 * `npm run mcap:backfill-labels` uses planMcapOhlcCapture and soft-overwrites
 * these rows when a later fetch returns bars.
 */
function needsOhlcBackfill(row: SignalOhlcLabelRow): boolean {
  return rowBarsEmpty(row) && row.ohlc_source !== BACKFILL_EMPTY_SOURCE
}

function resolveOhlcChain(
  tokenAddress: string,
  chain?: string | null,
): GmgnTradeChain | undefined {
  if (chain === 'robinhood' || chain === 'sol') return chain
  if (isEvmTokenAddress(tokenAddress)) return 'robinhood'
  return undefined
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const out = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++
      out[idx] = await fn(items[idx]!)
    }
  }
  const n = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

/**
 * One-shot backfill for gallery rows with empty bars (ST / gmgn token-ohlc path).
 * Failed attempts set ohlc_source=backfill_empty so gallery list loads do not
 * hammer ST; mcap --refill-empty / capture soft-overwrite still refill them.
 */
export async function backfillEmptySignalOhlcBars(
  row: SignalOhlcLabelRow,
  opts?: { force?: boolean },
): Promise<SignalOhlcLabelRow> {
  if (!opts?.force && !needsOhlcBackfill(row)) return row
  if (opts?.force && !rowBarsEmpty(row)) return row

  const startMs = new Date(row.window_start).getTime()
  const endMs = new Date(row.window_end).getTime()
  let startSec = Number.isFinite(startMs)
    ? Math.floor(startMs / 1000)
    : Math.floor((Date.now() - POTENTIAL_MAX_MS) / 1000)
  let endSec = Number.isFinite(endMs)
    ? Math.floor(endMs / 1000)
    : Math.floor(Date.now() / 1000)
  if (endSec <= startSec) {
    endSec = Math.floor(Date.now() / 1000)
    startSec = endSec - Math.floor(POTENTIAL_MAX_MS / 1000)
  }

  let bars: OhlcRugBar[] = []
  let ohlcSource = 'none'
  let fullSeries: OhlcRugBar[] = []
  const chain = resolveOhlcChain(row.token_address)

  try {
    const cached = await getCachedTokenOhlc24h1m(row.token_address)
    if (cached.candles.length > 0) {
      fullSeries = tokenOhlcToRugBars(cached.candles)
      bars = filterBarsToWindow(fullSeries, startSec, endSec)
      if (bars.length > 0) ohlcSource = cached.source || 'solanatracker'
    }

    if (bars.length === 0) {
      const { candles, source } = await fetchTokenOhlc({
        tokenAddress: row.token_address,
        timeFrom: startSec,
        timeTo: endSec,
        interval: '1m',
        chain,
      })
      const mapped = tokenOhlcToRugBars(candles)
      if (mapped.length > 0) fullSeries = mapped
      bars = filterBarsToWindow(mapped, startSec, endSec)
      if (bars.length > 0) ohlcSource = source || 'solanatracker'
    }

    if (bars.length === 0 && fullSeries.length === 0) {
      const { candles, source } = await fetchTokenOhlc({
        tokenAddress: row.token_address,
        hours: 24,
        interval: '1m',
        chain,
      })
      fullSeries = tokenOhlcToRugBars(candles)
      if (fullSeries.length > 0) {
        ohlcSource = source || 'solanatracker'
      }
    }

    if (bars.length === 0 && fullSeries.length > 0) {
      bars = takeLastOhlcBars(fullSeries, 10)
      ohlcSource = 'last10_fallback'
    }
  } catch (err) {
    console.warn('[signal-ohlc-labels] backfill fetch failed', {
      mint: row.token_address,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (bars.length === 0) {
    // Gallery cooldown only — do not invent a new empty INSERT. Soft overwrite
    // / --refill-empty still treat this row as refillable.
    await query(
      `UPDATE signal_ohlc_labels SET ohlc_source = $2
       WHERE id = $1::uuid
         AND (bars = '[]'::jsonb OR jsonb_array_length(bars) = 0)`,
      [row.id, BACKFILL_EMPTY_SOURCE],
    )
    await invalidateSignalOhlcLabelsCache(row.label)
    return { ...row, ohlc_source: BACKFILL_EMPTY_SOURCE }
  }

  const windowStartIso = new Date(bars[0]!.t * 1000).toISOString()
  const windowEndIso = new Date(bars[bars.length - 1]!.t * 1000).toISOString()

  const updated = await queryOne<SignalOhlcLabelRow>(
    `UPDATE signal_ohlc_labels
     SET bars = $2::jsonb,
         ohlc_source = $3,
         window_start = $4::timestamptz,
         window_end = $5::timestamptz
     WHERE id = $1::uuid
       AND (bars = '[]'::jsonb OR jsonb_array_length(bars) = 0)
     RETURNING *`,
    [
      row.id,
      JSON.stringify(bars),
      ohlcSource,
      windowStartIso,
      windowEndIso,
    ],
  )
  await invalidateSignalOhlcLabelsCache(row.label)
  return (
    updated ?? {
      ...row,
      bars,
      ohlc_source: ohlcSource,
      window_start: windowStartIso,
      window_end: windowEndIso,
    }
  )
}

async function backfillEmptyRows(
  rows: SignalOhlcLabelRow[],
): Promise<SignalOhlcLabelRow[]> {
  const needIdx = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => needsOhlcBackfill(r))
  if (needIdx.length === 0) return rows

  const filled = await mapPool(needIdx, BACKFILL_CONCURRENCY, ({ r }) =>
    backfillEmptySignalOhlcBars(r),
  )
  const out = rows.slice()
  for (let j = 0; j < needIdx.length; j++) {
    out[needIdx[j]!.i] = filled[j]!
  }
  return out
}

/** Capture once per (token, label). Prefer cached 24h×1m window; else narrow ST/GMGN.
 * Does not INSERT empty bars (would lock UNIQUE(token_address, label)).
 * Soft-overwrites existing empty slots (`none` / `backfill_empty` / bars=[]) when bars arrive.
 */
export async function captureSignalOhlcLabel(params: {
  tokenAddress: string
  /** UI label: potential | rugged | rug */
  label: string
  source?: string
  tokenSymbol?: string | null
  /** Optional chain hint (sol | robinhood). 0x mints default to robinhood. */
  chain?: string | null
}): Promise<string | null> {
  const storeLabel = toSignalOhlcStoreLabel(params.label)
  if (!storeLabel) return null

  await ensureSignalOhlcLabelsTable()

  const existing = await queryOne<
    Pick<SignalOhlcLabelRow, 'id' | 'bars' | 'ohlc_source'>
  >(
    `SELECT id, bars, ohlc_source FROM signal_ohlc_labels
     WHERE token_address = $1 AND label = $2
     LIMIT 1`,
    [params.tokenAddress, storeLabel],
  )
  if (existing && !isEmptySignalOhlcSlot(existing)) {
    return existing.id
  }

  const { ctx, symbol } = await loadTrackContext(params.tokenAddress)
  const { startMs, endMs, endReason } = resolveCaptureWindowMs(
    ctx,
    storeLabel,
  )
  const startSec = Math.floor(startMs / 1000)
  const endSec = Math.floor(endMs / 1000)
  const chain = resolveOhlcChain(params.tokenAddress, params.chain)

  let bars: OhlcRugBar[] = []
  let ohlcSource = 'none'
  let fullSeries: OhlcRugBar[] = []

  try {
    const cached = await getCachedTokenOhlc24h1m(params.tokenAddress)
    if (cached.candles.length > 0) {
      fullSeries = tokenOhlcToRugBars(cached.candles)
      bars = filterBarsToWindow(fullSeries, startSec, endSec)
      if (bars.length > 0) ohlcSource = cached.source || 'solanatracker'
    }

    // Window outside cache / brand-new mint — narrow ST / GMGN pull
    if (bars.length === 0) {
      const { candles, source } = await fetchTokenOhlc({
        tokenAddress: params.tokenAddress,
        timeFrom: startSec,
        timeTo: endSec,
        interval: '1m',
        chain,
      })
      const mapped = tokenOhlcToRugBars(candles)
      if (mapped.length > 0) fullSeries = mapped
      bars = filterBarsToWindow(mapped, startSec, endSec)
      if (bars.length > 0) ohlcSource = source || 'none'
    }

    // Still empty: last 10 of whatever series we have (Freeview-style)
    if (bars.length === 0 && fullSeries.length > 0) {
      bars = takeLastOhlcBars(fullSeries, 10)
      ohlcSource = 'last10_fallback'
    }
  } catch (err) {
    console.warn('[signal-ohlc-labels] capture fetch failed', {
      mint: params.tokenAddress,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  // Never lock UNIQUE with an empty corpus card — refill can retry later.
  if (bars.length === 0) {
    return null
  }

  const windowStartIso = new Date(bars[0]!.t * 1000).toISOString()
  const windowEndIso = new Date(bars[bars.length - 1]!.t * 1000).toISOString()

  if (existing) {
    const updated = await queryOne<{ id: string }>(
      `UPDATE signal_ohlc_labels
       SET token_symbol = COALESCE($2, token_symbol),
           window_start = $3::timestamptz,
           window_end = $4::timestamptz,
           ohlc_source = $5,
           bars = $6::jsonb,
           end_reason = $7,
           source = COALESCE($8, source)
       WHERE id = $1::uuid
         AND (bars = '[]'::jsonb OR jsonb_array_length(bars) = 0
              OR ohlc_source IN ('none', 'backfill_empty'))
       RETURNING id`,
      [
        existing.id,
        params.tokenSymbol ?? symbol,
        windowStartIso,
        windowEndIso,
        ohlcSource,
        JSON.stringify(bars),
        endReason,
        params.source ?? null,
      ],
    )
    await invalidateSignalOhlcLabelsCache(storeLabel)
    return updated?.id ?? existing.id
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO signal_ohlc_labels (
       token_address, token_symbol, label, window_start, window_end,
       ohlc_interval, ohlc_source, bars, end_reason, source
     ) VALUES ($1, $2, $3, $4, $5, '1m', $6, $7::jsonb, $8, $9)
     ON CONFLICT (token_address, label) DO UPDATE SET
       token_symbol = COALESCE(EXCLUDED.token_symbol, signal_ohlc_labels.token_symbol),
       window_start = EXCLUDED.window_start,
       window_end = EXCLUDED.window_end,
       ohlc_source = EXCLUDED.ohlc_source,
       bars = EXCLUDED.bars,
       end_reason = EXCLUDED.end_reason,
       source = COALESCE(EXCLUDED.source, signal_ohlc_labels.source)
     WHERE signal_ohlc_labels.bars = '[]'::jsonb
        OR jsonb_array_length(signal_ohlc_labels.bars) = 0
        OR signal_ohlc_labels.ohlc_source IN ('none', 'backfill_empty')
     RETURNING id`,
    [
      params.tokenAddress,
      params.tokenSymbol ?? symbol,
      storeLabel,
      windowStartIso,
      windowEndIso,
      ohlcSource,
      JSON.stringify(bars),
      endReason,
      params.source ?? null,
    ],
  )

  await invalidateSignalOhlcLabelsCache(storeLabel)

  if (rows[0]?.id) return rows[0].id

  const raced = await queryOne<{ id: string }>(
    `SELECT id FROM signal_ohlc_labels
     WHERE token_address = $1 AND label = $2
     LIMIT 1`,
    [params.tokenAddress, storeLabel],
  )
  return raced?.id ?? null
}

/**
 * Upsert gallery row from Freeview detect-snapshot bars.
 * Exclusive: deletes the other label row for the same mint.
 */
export async function upsertSignalOhlcLabelFromBars(params: {
  tokenAddress: string
  label: SignalOhlcLabelKind
  bars: OhlcRugBar[]
  tokenSymbol?: string | null
  source?: string | null
}): Promise<string | null> {
  const storeLabel = params.label
  await ensureSignalOhlcLabelsTable()

  if (!Array.isArray(params.bars) || params.bars.length === 0) {
    // No Freeview bars — try normal capture once
    return captureSignalOhlcLabel({
      tokenAddress: params.tokenAddress,
      label: storeLabel,
      tokenSymbol: params.tokenSymbol,
      source: params.source ?? 'freeview',
    })
  }

  const otherLabel: SignalOhlcLabelKind =
    storeLabel === 'potential' ? 'rug' : 'potential'
  await query(
    `DELETE FROM signal_ohlc_labels
     WHERE token_address = $1 AND label = $2`,
    [params.tokenAddress, otherLabel],
  )
  await invalidateSignalOhlcLabelsCache(otherLabel)

  const sorted = [...params.bars].sort((a, b) => a.t - b.t)
  const windowStartIso = new Date(sorted[0]!.t * 1000).toISOString()
  const windowEndIso = new Date(
    sorted[sorted.length - 1]!.t * 1000,
  ).toISOString()

  const { rows } = await query<{ id: string }>(
    `INSERT INTO signal_ohlc_labels (
       token_address, token_symbol, label, window_start, window_end,
       ohlc_interval, ohlc_source, bars, end_reason, source
     ) VALUES ($1, $2, $3, $4, $5, '1m', 'detect_snapshot', $6::jsonb, 'label_now', $7)
     ON CONFLICT (token_address, label) DO UPDATE SET
       token_symbol = COALESCE(EXCLUDED.token_symbol, signal_ohlc_labels.token_symbol),
       window_start = EXCLUDED.window_start,
       window_end = EXCLUDED.window_end,
       ohlc_source = EXCLUDED.ohlc_source,
       bars = EXCLUDED.bars,
       end_reason = EXCLUDED.end_reason,
       source = EXCLUDED.source
     RETURNING id`,
    [
      params.tokenAddress,
      params.tokenSymbol ?? null,
      storeLabel,
      windowStartIso,
      windowEndIso,
      JSON.stringify(sorted),
      params.source ?? 'freeview',
    ],
  )

  await invalidateSignalOhlcLabelsCache(storeLabel)
  return rows[0]?.id ?? null
}

/** Remove all gallery OHLC rows for a mint (Freeview → system). */
export async function removeSignalOhlcLabelsForToken(
  tokenAddress: string,
): Promise<void> {
  await ensureSignalOhlcLabelsTable()
  await query(`DELETE FROM signal_ohlc_labels WHERE token_address = $1`, [
    tokenAddress,
  ])
  await invalidateSignalOhlcLabelsCache('potential')
  await invalidateSignalOhlcLabelsCache('rug')
}

async function listFromDb(params: {
  label?: SignalOhlcLabelKind | null
  limit: number
  offset: number
}): Promise<SignalOhlcLabelRow[]> {
  if (params.label === 'potential' || params.label === 'rug') {
    const { rows } = await query<SignalOhlcLabelRow>(
      `SELECT * FROM signal_ohlc_labels
       WHERE label = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [params.label, params.limit, params.offset],
    )
    return rows
  }

  const { rows } = await query<SignalOhlcLabelRow>(
    `SELECT * FROM signal_ohlc_labels
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [params.limit, params.offset],
  )
  return rows
}

/** Parse a signal_ohlc_labels.bars JSON value into paint bars. Drops junk rows. */
export function parseStoredOhlcBars(raw: unknown): OhlcRugBar[] {
  if (!Array.isArray(raw)) return []
  const out: OhlcRugBar[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const b = item as Record<string, unknown>
    const t = Number(b.t)
    const o = Number(b.o)
    const h = Number(b.h)
    const l = Number(b.l)
    const c = Number(b.c)
    if (![t, o, h, l, c].every((n) => Number.isFinite(n))) continue
    const v = b.v == null ? undefined : Number(b.v)
    out.push({
      t,
      o,
      h,
      l,
      c,
      ...(v != null && Number.isFinite(v) ? { v } : {}),
    })
  }
  return out
}

/**
 * Newest non-empty stored bars for a mint. Used when live Tracker OHLC is empty.
 * Never throws — CLOSE must still send.
 */
export async function loadStoredSignalOhlcBars(
  tokenAddress: string,
): Promise<OhlcRugBar[]> {
  const mint = tokenAddress.trim()
  if (!mint) return []
  try {
    await ensureSignalOhlcLabelsTable()
    const row = await queryOne<{ bars: unknown }>(
      `SELECT bars FROM signal_ohlc_labels
       WHERE token_address = $1
         AND jsonb_typeof(bars) = 'array'
         AND jsonb_array_length(bars) > 0
       ORDER BY created_at DESC
       LIMIT 1`,
      [mint],
    )
    return parseStoredOhlcBars(row?.bars)
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      console.warn(
        '[signal-ohlc-labels] stored bars lookup failed:',
        error instanceof Error ? error.message : String(error),
      )
    }
    return []
  }
}

export async function listSignalOhlcLabels(params: {
  label?: SignalOhlcLabelKind | null
  limit?: number
  offset?: number
}): Promise<SignalOhlcLabelRow[]> {
  await ensureSignalOhlcLabelsTable()
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
  const offset = Math.max(params.offset ?? 0, 0)

  if (params.label === 'potential' || params.label === 'rug') {
    const key = signalOhlcLabelsCacheKey(params.label, limit, offset)
    const cached = await cacheGet<SignalOhlcLabelRow[]>(key)
    if (cached && !cached.some(needsOhlcBackfill)) {
      return cached
    }

    const base =
      cached && cached.some(needsOhlcBackfill)
        ? cached
        : await listFromDb({ label: params.label, limit, offset })
    const rows = await backfillEmptyRows(base)
    await cacheSet(key, rows, SIGNAL_OHLC_LABELS_CACHE_TTL_SEC)
    return rows
  }

  const rows = await listFromDb({ label: params.label, limit, offset })
  return backfillEmptyRows(rows)
}
