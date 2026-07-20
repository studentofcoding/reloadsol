import { query, queryOne } from '@/utils/db'
import {
  getCachedTokenOhlc24h1m,
  tokenOhlcToRugBars,
} from '@/strategies/token-map-chart'
import {
  evaluateOhlcRugRules,
  OHLC_RUG_MAX_BARS,
  ohlcRugHitReasons,
  takeLastOhlcBars,
  type OhlcRugBar,
  type OhlcRugEval,
} from '@/strategies/ohlc-rug-rules'

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS token_detect_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL
    CHECK (source IN ('concentration', 'freeview')),
  ohlc_interval TEXT NOT NULL DEFAULT '1m'
    CHECK (ohlc_interval IN ('1m', '5m', '15m', '1h')),
  bars JSONB NOT NULL DEFAULT '[]'::jsonb,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  rule_hits JSONB NOT NULL DEFAULT '[]'::jsonb,
  rug_label TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_detect_snapshots_token_detected
  ON token_detect_snapshots (token_address, detected_at DESC);
ALTER TABLE token_detect_snapshots
  DROP CONSTRAINT IF EXISTS token_detect_snapshots_rug_label_check;
UPDATE token_detect_snapshots SET rug_label = 'potential' WHERE rug_label = 'not_rug';
DO $$ BEGIN
  ALTER TABLE token_detect_snapshots
    ADD CONSTRAINT token_detect_snapshots_rug_label_check
    CHECK (rug_label IN ('system', 'rug', 'potential'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`

let ensurePromise: Promise<void> | null = null

export async function ensureDetectSnapshotsTable(): Promise<void> {
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

export type DetectSnapshotSource = 'concentration' | 'freeview'
export type DetectRugLabel = 'system' | 'rug' | 'potential'

export type DetectSnapshotRow = {
  id: string
  token_address: string
  detected_at: string
  source: DetectSnapshotSource
  ohlc_interval: string
  bars: OhlcRugBar[]
  features: OhlcRugEval['features']
  rule_hits: OhlcRugEval['hits']
  rug_label: DetectRugLabel
  updated_at: string
}

export async function fetchLastOhlcRugBars(
  tokenAddress: string,
  n = OHLC_RUG_MAX_BARS,
): Promise<{ bars: OhlcRugBar[]; source: string }> {
  const { candles, source } = await getCachedTokenOhlc24h1m(tokenAddress)
  const mapped = tokenOhlcToRugBars(candles)
  return { bars: takeLastOhlcBars(mapped, n), source }
}

export async function insertDetectSnapshot(params: {
  tokenAddress: string
  source: DetectSnapshotSource
  bars: OhlcRugBar[]
  evalResult: OhlcRugEval
  rugLabel?: DetectRugLabel
}): Promise<string | null> {
  await ensureDetectSnapshotsTable()
  const { rows } = await query<{ id: string }>(
    `INSERT INTO token_detect_snapshots (
       token_address, source, ohlc_interval, bars, features, rule_hits, rug_label
     ) VALUES ($1, $2, '1m', $3::jsonb, $4::jsonb, $5::jsonb, $6)
     RETURNING id`,
    [
      params.tokenAddress,
      params.source,
      JSON.stringify(params.bars),
      JSON.stringify(params.evalResult.features),
      JSON.stringify(params.evalResult.hits),
      params.rugLabel ?? 'system',
    ],
  )
  return rows[0]?.id ?? null
}

/** Fetch OHLC, evaluate rules, persist. Returns eval + reasons. */
export async function captureDetectSnapshot(params: {
  tokenAddress: string
  source: DetectSnapshotSource
}): Promise<{
  snapshotId: string | null
  bars: OhlcRugBar[]
  evalResult: OhlcRugEval
  reasons: string[]
}> {
  const { bars } = await fetchLastOhlcRugBars(params.tokenAddress)
  const evalResult = evaluateOhlcRugRules(bars)
  const snapshotId = await insertDetectSnapshot({
    tokenAddress: params.tokenAddress,
    source: params.source,
    bars,
    evalResult,
  })
  return {
    snapshotId,
    bars,
    evalResult,
    reasons: ohlcRugHitReasons(evalResult),
  }
}

export async function getLatestDetectSnapshot(
  tokenAddress: string,
): Promise<DetectSnapshotRow | null> {
  await ensureDetectSnapshotsTable()
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM token_detect_snapshots
     WHERE token_address = $1
     ORDER BY detected_at DESC
     LIMIT 1`,
    [tokenAddress],
  )
  if (!row) return null
  return mapRow(row)
}

export async function updateDetectSnapshotLabel(
  tokenAddress: string,
  rugLabel: DetectRugLabel,
): Promise<DetectSnapshotRow | null> {
  await ensureDetectSnapshotsTable()
  if (rugLabel !== 'rug' && rugLabel !== 'potential' && rugLabel !== 'system') {
    return null
  }
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE token_detect_snapshots SET rug_label = $2, updated_at = NOW()
     WHERE id = (
       SELECT id FROM token_detect_snapshots
       WHERE token_address = $1
       ORDER BY detected_at DESC
       LIMIT 1
     )
     RETURNING *`,
    [tokenAddress, rugLabel],
  )
  if (!row) return null
  return mapRow(row)
}

function mapRow(row: Record<string, unknown>): DetectSnapshotRow {
  const raw = String(row.rug_label ?? 'system')
  const rug_label: DetectRugLabel =
    raw === 'rug' || raw === 'potential'
      ? raw
      : raw === 'not_rug'
        ? 'potential'
        : 'system'
  return {
    id: String(row.id),
    token_address: String(row.token_address),
    detected_at: String(row.detected_at),
    source: row.source as DetectSnapshotSource,
    ohlc_interval: String(row.ohlc_interval ?? '1m'),
    bars: (row.bars as OhlcRugBar[]) ?? [],
    features: (row.features as OhlcRugEval['features']) ?? {
      n: 0,
      dumpPct: null,
      avgUpperWick: null,
      wickTripBars: 0,
      volDeathRatio: null,
    },
    rule_hits: (row.rule_hits as OhlcRugEval['hits']) ?? [],
    rug_label,
    updated_at: String(row.updated_at),
  }
}
