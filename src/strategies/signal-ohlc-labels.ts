import { query, queryOne } from '@/utils/db'
import { cacheDelByPrefix, cacheGet, cacheSet } from '@/utils/redis-cache'
import { getLatestDetectSnapshot } from '@/strategies/detect-snapshots'
import { fetchTokenOhlc } from '@/strategies/token-map-chart'
import type { OhlcRugBar } from '@/strategies/ohlc-rug-rules'
import {
  POTENTIAL_MAX_MS,
  resolveSignalOhlcWindow,
  resolveTrackStartMs,
  toSignalOhlcStoreLabel,
  type SignalOhlcLabelKind,
  type TrackContext,
} from '@/strategies/signal-ohlc-window'

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

/** Capture once per (token, label). Copy Freeview snapshot first 10m; else ST. */
export async function captureSignalOhlcLabel(params: {
  tokenAddress: string
  /** UI label: potential | rugged | rug */
  label: string
  source?: string
  tokenSymbol?: string | null
}): Promise<string | null> {
  const storeLabel = toSignalOhlcStoreLabel(params.label)
  if (!storeLabel) return null

  await ensureSignalOhlcLabelsTable()

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM signal_ohlc_labels
     WHERE token_address = $1 AND label = $2
     LIMIT 1`,
    [params.tokenAddress, storeLabel],
  )
  if (existing) return existing.id

  const { ctx, symbol } = await loadTrackContext(params.tokenAddress)
  const metaWindow = resolveSignalOhlcWindow({ label: storeLabel, ctx })

  const startMs = resolveTrackStartMs(ctx)
  const endMs = startMs + POTENTIAL_MAX_MS
  const startSec = Math.floor(startMs / 1000)
  const endSec = Math.floor(endMs / 1000)

  let bars: OhlcRugBar[] = []
  let ohlcSource = 'none'

  const snap = await getLatestDetectSnapshot(params.tokenAddress)
  if (snap?.bars?.length) {
    bars = filterBarsToWindow(snap.bars, startSec, endSec)
    // Snapshot is often last-10 of hour — if no overlap, use snapshot as-is
    if (bars.length === 0) bars = snap.bars
    ohlcSource = 'detect_snapshot'
  }

  if (bars.length === 0) {
    const { candles, source } = await fetchTokenOhlc({
      tokenAddress: params.tokenAddress,
      timeFrom: startSec,
      timeTo: endSec,
      interval: '1m',
    })
    bars = candles
      .filter((c) => c.time >= startSec && c.time <= endSec)
      .map((c) => ({
        t: c.time,
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        ...(c.volume != null ? { v: c.volume } : {}),
      }))
    ohlcSource = source || 'none'
  }

  let windowStartIso = new Date(startMs).toISOString()
  let windowEndIso = new Date(endMs).toISOString()
  if (bars.length > 0) {
    windowStartIso = new Date(bars[0]!.t * 1000).toISOString()
    windowEndIso = new Date(bars[bars.length - 1]!.t * 1000).toISOString()
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO signal_ohlc_labels (
       token_address, token_symbol, label, window_start, window_end,
       ohlc_interval, ohlc_source, bars, end_reason, source
     ) VALUES ($1, $2, $3, $4, $5, '1m', $6, $7::jsonb, $8, $9)
     ON CONFLICT (token_address, label) DO NOTHING
     RETURNING id`,
    [
      params.tokenAddress,
      params.tokenSymbol ?? symbol,
      storeLabel,
      windowStartIso,
      windowEndIso,
      ohlcSource,
      JSON.stringify(bars),
      metaWindow.endReason,
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
    if (cached) return cached

    const rows = await listFromDb({ label: params.label, limit, offset })
    await cacheSet(key, rows, SIGNAL_OHLC_LABELS_CACHE_TTL_SEC)
    return rows
  }

  return listFromDb({ label: params.label, limit, offset })
}
