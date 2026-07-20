import { query, queryOne } from '@/utils/db'
import { fetchTokenOhlc } from '@/strategies/token-map-chart'
import {
  resolveSignalOhlcWindow,
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
`

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
    // peak from mcap peak_seen_at used when price_history missing
    price_history:
      (trending?.price_history as TrackContext['price_history']) ?? null,
  }

  // If no price_history peak, synthesize a single peak point from mcap peak_seen_at
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
  const { ctx, symbol } = await loadTrackContext(params.tokenAddress)
  const window = resolveSignalOhlcWindow({ label: storeLabel, ctx })

  const startSec = Math.floor(new Date(window.windowStartIso).getTime() / 1000)
  const endSec = Math.floor(new Date(window.windowEndIso).getTime() / 1000)

  const { candles, source } = await fetchTokenOhlc({
    tokenAddress: params.tokenAddress,
    timeFrom: startSec,
    timeTo: endSec,
    interval: '1m',
  })

  const bars = candles
    .filter((c) => c.time >= startSec && c.time <= endSec)
    .map((c) => ({
      t: c.time,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      ...(c.volume != null ? { v: c.volume } : {}),
    }))

  const { rows } = await query<{ id: string }>(
    `INSERT INTO signal_ohlc_labels (
       token_address, token_symbol, label, window_start, window_end,
       ohlc_interval, ohlc_source, bars, end_reason, source
     ) VALUES ($1, $2, $3, $4, $5, '1m', $6, $7::jsonb, $8, $9)
     RETURNING id`,
    [
      params.tokenAddress,
      params.tokenSymbol ?? symbol,
      storeLabel,
      window.windowStartIso,
      window.windowEndIso,
      source || 'none',
      JSON.stringify(bars),
      window.endReason,
      params.source ?? null,
    ],
  )
  return rows[0]?.id ?? null
}

/** Schedule capture without failing the caller. */
export function scheduleSignalOhlcCapture(params: {
  tokenAddress: string
  label: string
  source?: string
  tokenSymbol?: string | null
}): void {
  if (!toSignalOhlcStoreLabel(params.label)) return
  void captureSignalOhlcLabel(params).catch((err) => {
    console.warn('[signal-ohlc-labels] capture failed', {
      mint: params.tokenAddress,
      label: params.label,
      error: err instanceof Error ? err.message : String(err),
    })
  })
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
    const { rows } = await query<SignalOhlcLabelRow>(
      `SELECT * FROM signal_ohlc_labels
       WHERE label = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [params.label, limit, offset],
    )
    return rows
  }

  const { rows } = await query<SignalOhlcLabelRow>(
    `SELECT * FROM signal_ohlc_labels
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return rows
}
