/**
 * Token metrics history — the durable per-token metric series (the backbone).
 *
 * ONE ROW PER (token, chain, UTC hour) holding 60 one-minute volume slots. See
 * db/init/54-token-metrics-history.sql for why this shape was chosen (measured) and for the
 * invariants the read paths must honour. The two that matter most here:
 *
 *   * **NULL is never zero.** A slot we did not observe must never read as "no volume" — that is
 *     exactly the signal the ramp score keys on, so nothing in this module coerces NULL to 0.
 *   * **A 5m bucket carries a volume only if all five of its minutes were observed**, mirroring
 *     `aggregateTo5m()` in src/strategies/rug-signal.ts. `derive5mVolume` is the single
 *     implementation of that rule and is differentially tested against `aggregateTo5m`.
 *
 * Writes are one atomic statement per (token, hour): slots are filled with
 * `COALESCE(vol_min[slot], value)`, so the first vendor to supply a minute wins and a re-write of
 * the same candle is a no-op.
 */

import { query } from '@/utils/db'

export const SLOTS_PER_HOUR = 60
export const MINUTES_PER_5M = 5
export const FIVE_MIN_PER_HOUR = SLOTS_PER_HOUR / MINUTES_PER_5M

export type TokenMetricsSource =
  | 'brain'
  | 'solana_tracker'
  | 'gmgn_kline'
  | 'gmgn_web'
  | 'cache_copy'
  | 'snapshot'

/**
 * A 1m candle as read from any vendor: `t` is unix seconds, everything else optional.
 *
 * The four price fields are stored **independently of volume** — a source that only has a rolling
 * volume figure may omit them, and a missing field stays NULL rather than becoming 0.
 */
export type CandleVolume = {
  t: number
  v?: number | null
  o?: number | null
  h?: number | null
  l?: number | null
  c?: number | null
}

/** One minute slot. `value` is the volume (the gate for whether the minute is written at all). */
export type HourSlot = {
  slot: number
  value: number
  o?: number | null
  h?: number | null
  l?: number | null
  c?: number | null
}

export type HourPlan = {
  /** UTC hour start, ISO (what Postgres stores). */
  hourIso: string
  /** 1-based slot → candle, ascending, deduped (first wins within the batch). */
  slots: HourSlot[]
}

export type MetricsHourRow = {
  hour_bucket: string
  vol_min: Array<number | null> | null
  o_min?: Array<number | null> | null
  h_min?: Array<number | null> | null
  l_min?: Array<number | null> | null
  c_min?: Array<number | null> | null
}

/** One observed minute of the OHLCV series. An absent field is `null`, never 0. */
export type OhlcvMinute = {
  t: number
  o: number | null
  h: number | null
  l: number | null
  c: number | null
  v: number | null
}

function slotValue(arr: Array<number | null> | null | undefined, index: number): number | null {
  if (!Array.isArray(arr)) return null
  const value = arr[index]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export type FiveMinBucket = { t: number; volume: number | null }

function finiteVolume(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v >= 0 ? v : null
}

/** Floor an instant to its UTC hour. */
export function hourBucketUtc(at: Date): Date {
  const ms = at.getTime()
  return new Date(ms - (ms % 3_600_000))
}

/**
 * 1-based array slot for an instant. Postgres arrays are 1-based, so minute 0 → slot 1 and
 * minute 59 → slot 60. Derived from **UTC** minutes so DST can never shift it.
 */
export function minuteSlot(at: Date): number {
  return at.getUTCMinutes() + 1
}

/** ISO hour start for an instant (the storage key). */
export function hourBucketIso(at: Date): string {
  return hourBucketUtc(at).toISOString()
}

/**
 * Group candles into per-hour slot plans, carrying each minute's full OHLCV.
 *
 * Every rule here is an edge case that has a test:
 *  - buckets by **the candle's own timestamp**, never by wall-clock (a candle at 12:59 written at
 *    13:00 must land in the 12:00 row);
 *  - **volume is the gate**: a candle with no finite volume is skipped entirely, so a missing minute
 *    is never written as a 0 (an observed 0 is still written — that is data);
 *  - drops non-finite and negative values (invariant 6), for prices as well as volume;
 *  - dedupes within a batch, first wins (consistent with the DB-side first-writer-wins);
 *  - OHLC rides along with the volume slot; an absent price stays absent rather than defaulting to
 *    the volume's presence;
 *  - returns one plan per distinct hour, so a multi-hour backlog writes several rows.
 */
export function planSlotWrites(candles: CandleVolume[]): HourPlan[] {
  const byHour = new Map<string, Map<number, HourSlot>>()

  for (const candle of candles) {
    const volume = finiteVolume(candle.v)
    if (volume == null) continue
    if (!Number.isFinite(candle.t)) continue

    const at = new Date(candle.t * 1000)
    const hourIso = hourBucketIso(at)
    const slot = minuteSlot(at)

    let slots = byHour.get(hourIso)
    if (!slots) {
      slots = new Map()
      byHour.set(hourIso, slots)
    }
    if (slots.has(slot)) continue
    const o = finiteVolume(candle.o)
    const h = finiteVolume(candle.h)
    const l = finiteVolume(candle.l)
    const c = finiteVolume(candle.c)
    slots.set(slot, {
      slot,
      value: volume,
      // Only carry prices that were actually observed — an absent one stays absent rather than
      // becoming an explicit null the DB would have to distinguish from "not written".
      ...(o != null ? { o } : {}),
      ...(h != null ? { h } : {}),
      ...(l != null ? { l } : {}),
      ...(c != null ? { c } : {}),
    })
  }

  return [...byHour.entries()]
    .map(([hourIso, slots]) => ({
      hourIso,
      slots: [...slots.values()].sort((a, b) => a.slot - b.slot),
    }))
    .sort((a, b) => (a.hourIso < b.hourIso ? -1 : 1))
}

/** Non-null slot count — the coverage number, derived rather than stored. */
export function filledSlots(row: MetricsHourRow): number {
  if (!Array.isArray(row.vol_min)) return 0
  let n = 0
  for (const v of row.vol_min) {
    if (typeof v === 'number' && Number.isFinite(v)) n++
  }
  return n
}

/**
 * Derive the 5-minute volume series from hour rows.
 *
 * The single implementation of invariant 5: a 5m bucket gets a volume **only when all five of its
 * minutes were observed**; otherwise `volume: null` — never a partial sum, and never 0 for a
 * missing minute. A 5m bucket cannot straddle an hour (60 % 5 === 0), so the rule is per-row.
 */
export function derive5mVolume(rows: MetricsHourRow[]): FiveMinBucket[] {
  const out: FiveMinBucket[] = []

  for (const row of rows) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs)) continue
    const slots = Array.isArray(row.vol_min) ? row.vol_min : []

    for (let bucket = 0; bucket < FIVE_MIN_PER_HOUR; bucket++) {
      const from = bucket * MINUTES_PER_5M
      let sum = 0
      let complete = true

      for (let i = from; i < from + MINUTES_PER_5M; i++) {
        const v = slots[i]
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          complete = false
          break
        }
        sum += v
      }

      out.push({
        t: Math.floor((hourMs + from * 60_000) / 1000),
        volume: complete ? sum : null,
      })
    }
  }

  return out.sort((a, b) => a.t - b.t)
}

const INSERT_HOUR_SQL = `
INSERT INTO token_metrics_history (
  token_address, chain, hour_bucket, vol_min, o_min, h_min, l_min, c_min, sources, updated_at
) VALUES (
  $1, $2, $3::timestamptz,
  array_fill(NULL::float8, ARRAY[60]), array_fill(NULL::float8, ARRAY[60]),
  array_fill(NULL::float8, ARRAY[60]), array_fill(NULL::float8, ARRAY[60]),
  array_fill(NULL::float8, ARRAY[60]), $4::text[], NOW()
)
ON CONFLICT (token_address, chain, hour_bucket) DO NOTHING
`

/**
 * Fill slots on one hour row, atomically — volume and OHLC, each field independently.
 *
 * `COALESCE(<field>[slot], incoming)` is the first-writer-wins rule **per field**: an existing
 * minute is never overwritten, a duplicate write is a no-op, and two sources cannot clobber each
 * other. `COALESCE` is what keeps an absent incoming price from erasing a stored one.
 *
 * Every column is written in the same statement, so a row can never carry a volume with a stale
 * price from a different write.
 */
const MERGE_SLOTS_SQL = `
UPDATE token_metrics_history
   SET vol_min = (
         SELECT array_agg(COALESCE(vol_min[i], u.v) ORDER BY i)
           FROM generate_series(1, 60) AS i
           LEFT JOIN unnest($4::int[], $5::float8[]) AS u(slot, v) ON u.slot = i
       ),
       o_min = (
         SELECT array_agg(COALESCE(o_min[i], u.o) ORDER BY i)
           FROM generate_series(1, 60) AS i
           LEFT JOIN unnest($4::int[], $6::float8[]) AS u(slot, o) ON u.slot = i
       ),
       h_min = (
         SELECT array_agg(COALESCE(h_min[i], u.h) ORDER BY i)
           FROM generate_series(1, 60) AS i
           LEFT JOIN unnest($4::int[], $7::float8[]) AS u(slot, h) ON u.slot = i
       ),
       l_min = (
         SELECT array_agg(COALESCE(l_min[i], u.l) ORDER BY i)
           FROM generate_series(1, 60) AS i
           LEFT JOIN unnest($4::int[], $8::float8[]) AS u(slot, l) ON u.slot = i
       ),
       c_min = (
         SELECT array_agg(COALESCE(c_min[i], u.c) ORDER BY i)
           FROM generate_series(1, 60) AS i
           LEFT JOIN unnest($4::int[], $9::float8[]) AS u(slot, c) ON u.slot = i
       ),
       sources = (
         SELECT array_agg(DISTINCT s) FROM unnest(sources || $10::text[]) AS s
       ),
       updated_at = NOW()
 WHERE token_address = $1 AND chain = $2 AND hour_bucket = $3::timestamptz
RETURNING token_address
`

export type RecordHoursResult = {
  /** Hour rows created or merged. */
  hoursWritten: number
  /** Slots attempted across all plans (before dedupe against existing minutes). */
  slotsAttempted: number
}

/**
 * Write candle volumes into the series. Best-effort by contract: this runs next to live trading
 * paths, so it never throws — it logs and returns what it managed.
 */
export async function recordMetricHours(params: {
  tokenAddress: string
  chain?: string
  candles: CandleVolume[]
  source: TokenMetricsSource
}): Promise<RecordHoursResult> {
  const tokenAddress = params.tokenAddress?.trim()
  if (!tokenAddress) return { hoursWritten: 0, slotsAttempted: 0 }

  const plans = planSlotWrites(params.candles)
  if (plans.length === 0) return { hoursWritten: 0, slotsAttempted: 0 }

  const chain = params.chain?.trim() || 'sol'
  let hoursWritten = 0
  let slotsAttempted = 0

  try {
    for (const plan of plans) {
      const slots = plan.slots.map((s) => s.slot)
      const values = plan.slots.map((s) => s.value)
      const opens = plan.slots.map((s) => s.o ?? null)
      const highs = plan.slots.map((s) => s.h ?? null)
      const lows = plan.slots.map((s) => s.l ?? null)
      const closes = plan.slots.map((s) => s.c ?? null)
      slotsAttempted += slots.length

      await query(INSERT_HOUR_SQL, [tokenAddress, chain, plan.hourIso, [params.source]])
      const { rowCount } = await query(MERGE_SLOTS_SQL, [
        tokenAddress,
        chain,
        plan.hourIso,
        slots,
        values,
        opens,
        highs,
        lows,
        closes,
        [params.source],
      ])
      if ((rowCount ?? 0) > 0) hoursWritten++
    }
  } catch (error) {
    console.warn('[token-metrics-history] write failed', {
      mint: tokenAddress,
      hours: plans.length,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return { hoursWritten, slotsAttempted }
}

const SNAPSHOT_SQL = `
INSERT INTO token_metrics_history (
  token_address, chain, hour_bucket, mcap_close, liquidity_close, price_close, holders, sources, updated_at
)
SELECT m, c, hb, mc, lq, pr, ho, ARRAY[$8::text], NOW()
  FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::float8[], $5::float8[], $6::float8[], $7::int[])
       AS u(m, c, hb, mc, lq, pr, ho)
ON CONFLICT (token_address, chain, hour_bucket) DO UPDATE SET
  mcap_close      = COALESCE(EXCLUDED.mcap_close,      token_metrics_history.mcap_close),
  liquidity_close = COALESCE(EXCLUDED.liquidity_close, token_metrics_history.liquidity_close),
  price_close     = COALESCE(EXCLUDED.price_close,     token_metrics_history.price_close),
  holders         = COALESCE(EXCLUDED.holders,         token_metrics_history.holders),
  sources         = (SELECT array_agg(DISTINCT s)
                       FROM unnest(token_metrics_history.sources || EXCLUDED.sources) AS s),
  updated_at      = NOW()
`

export type MetricSnapshot = {
  tokenAddress: string
  chain?: string
  mcap?: number | null
  liquidityUsd?: number | null
  priceUsd?: number | null
  holders?: number | null
}

/**
 * Write the current-hour **close** values (mcap / liquidity / price / holders) for many tokens in
 * one statement. Deliberately cannot touch `vol_min`: a rolling window reading (Jupiter `stats5m`,
 * GMGN `price.volume_5m`) is not a per-minute candle, and putting one in a slot would fabricate
 * precision the source does not have (E15).
 */
export async function recordMetricSnapshots(
  samples: MetricSnapshot[],
  at: Date = new Date(),
  source: TokenMetricsSource = 'snapshot',
): Promise<number> {
  const usable = samples.filter((s) => s.tokenAddress?.trim())
  if (usable.length === 0) return 0

  const hourIso = hourBucketIso(at)
  try {
    const { rowCount } = await query(SNAPSHOT_SQL, [
      usable.map((s) => s.tokenAddress.trim()),
      usable.map((s) => s.chain?.trim() || 'sol'),
      usable.map(() => hourIso),
      usable.map((s) => finiteVolume(s.mcap)),
      usable.map((s) => finiteVolume(s.liquidityUsd)),
      usable.map((s) => finiteVolume(s.priceUsd)),
      usable.map((s) => {
        const h = finiteVolume(s.holders)
        return h == null ? null : Math.round(h)
      }),
      source,
    ])
    return rowCount ?? 0
  } catch (error) {
    console.warn('[token-metrics-history] snapshot write failed', {
      rows: usable.length,
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}

/** Hour rows for one token inside a window, oldest first. SQL stays dumb; derivation is in TS. */
export async function loadMetricsHours(params: {
  tokenAddress: string
  chain?: string
  fromIso: string
  toIso: string
}): Promise<MetricsHourRow[]> {
  const { rows } = await query<MetricsHourRow>(
    `SELECT hour_bucket, vol_min, o_min, h_min, l_min, c_min
       FROM token_metrics_history
      WHERE token_address = $1 AND chain = $2
        AND hour_bucket >= date_trunc('hour', $3::timestamptz)
        AND hour_bucket <= $4::timestamptz
      ORDER BY hour_bucket ASC`,
    [params.tokenAddress, params.chain ?? 'sol', params.fromIso, params.toIso],
  )
  return rows
}

/** 5m volume series for one token — the reader the ramp verdict and the ML features will use. */
export async function load5mVolumeSeries(params: {
  tokenAddress: string
  chain?: string
  fromIso: string
  toIso: string
}): Promise<FiveMinBucket[]> {
  return derive5mVolume(await loadMetricsHours(params))
}

/**
 * Expand hour rows into per-minute candles, ascending by time.
 *
 * A minute is emitted when **any** of its five fields was observed: a minute where only the volume
 * is known still carries a real bar, and dropping it would throw the volume away. An absent field
 * comes back as `null` — never 0 — so a consumer can tell a flat minute from an unobserved one.
 * Mirrors `filledSlots`' rule of reading the array rather than trusting a stored count.
 */
export function expandHourRowsToOhlcv(rows: MetricsHourRow[]): OhlcvMinute[] {
  const out: OhlcvMinute[] = []

  for (const row of rows) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs)) continue

    for (let i = 0; i < SLOTS_PER_HOUR; i++) {
      const o = slotValue(row.o_min, i)
      const h = slotValue(row.h_min, i)
      const l = slotValue(row.l_min, i)
      const c = slotValue(row.c_min, i)
      const v = slotValue(row.vol_min, i)
      if (o == null && h == null && l == null && c == null && v == null) continue
      out.push({ t: Math.floor((hourMs + i * 60_000) / 1000), o, h, l, c, v })
    }
  }

  return out.sort((a, b) => a.t - b.t)
}

/** The 1m OHLCV series for one token — the full candle the copier captured. */
export async function load1mOhlcv(params: {
  tokenAddress: string
  chain?: string
  fromIso: string
  toIso: string
}): Promise<OhlcvMinute[]> {
  return expandHourRowsToOhlcv(await loadMetricsHours(params))
}

export type MetricsHistoryStats = {
  rows: number
  tokens: number
  hours: number
  oldest: string | null
  newest: string | null
  rowsPerDay: number
  /** Coverage is reported, never assumed. */
  hoursWithFullHour: number
  meanSlotsFilled: number
  projected30dRows: number
}

/** Ops/observability read: how much the series holds, and how completely. */
export async function metricsHistoryStats(): Promise<MetricsHistoryStats> {
  const { rows } = await query<{
    rows: string
    tokens: string
    oldest: string | null
    newest: string | null
    full_hours: string
    filled: string
  }>(
    `SELECT COUNT(*)::text AS rows,
            COUNT(DISTINCT token_address)::text AS tokens,
            MIN(hour_bucket)::text AS oldest,
            MAX(hour_bucket)::text AS newest,
            COUNT(*) FILTER (
              WHERE (SELECT count(x) FROM unnest(vol_min) AS x) = 60
            )::text AS full_hours,
            COALESCE(SUM((SELECT count(x) FROM unnest(vol_min) AS x)), 0)::text AS filled
       FROM token_metrics_history`,
  )
  const row = rows[0]
  const count = Number(row?.rows ?? 0)
  const spanMs =
    row?.oldest && row?.newest
      ? new Date(row.newest).getTime() - new Date(row.oldest).getTime()
      : 0
  const days = spanMs > 0 ? spanMs / 86_400_000 : 0
  const rowsPerDay = days > 0 ? Math.round(count / days) : 0

  return {
    rows: count,
    tokens: Number(row?.tokens ?? 0),
    hours: count,
    oldest: row?.oldest ?? null,
    newest: row?.newest ?? null,
    rowsPerDay,
    hoursWithFullHour: Number(row?.full_hours ?? 0),
    meanSlotsFilled: count > 0 ? Number(row?.filled ?? 0) / count : 0,
    projected30dRows: rowsPerDay * 30,
  }
}

/** Retention: prune whole hours only. Default 30 days at ~450k rows/day ≈ 13.5M rows worst case. */
export async function pruneTokenMetricsHistory(days?: number): Promise<number> {
  const parsed = Number(process.env.TOKEN_METRICS_RETENTION_DAYS)
  const keepDays = days ?? (Number.isFinite(parsed) && parsed > 0 ? parsed : 30)
  const { rowCount } = await query(
    `DELETE FROM token_metrics_history
      WHERE hour_bucket < NOW() - make_interval(days => $1::int)`,
    [keepDays],
  )
  return rowCount ?? 0
}
