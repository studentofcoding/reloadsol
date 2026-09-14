/**
 * Postgres paper-interest rows for `buybulk-datapublic-scout`.
 *
 * Mirrors strategy_review_notes: dedicated additive table + ensure-on-read.
 * Not trading_records (would look like open sim buys / pollute PnL) and not
 * strategy_outcomes (reports/ML). Never writes rhtape-datapublic-scout.
 */

import { query } from '@/utils/db'
import type { ClimateChipLabel } from '@/utils/climateDisplay'
import {
  BUYBULK_DATAPUBLIC_SCOUT_ID,
  RHTAPE_DATAPUBLIC_SCOUT_ID,
  canPaperNotchFromClimate,
  mintKey,
  type ScoutCandidate,
  type ScoutChain,
} from '@/utils/data-public-scout'
import type { PaperNotch } from '@/utils/paper-notch-store'

export const STRATEGY_PAPER_NOTCHES_TABLE = 'strategy_paper_notches'

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS strategy_paper_notches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id TEXT NOT NULL
    CHECK (strategy_id = 'buybulk-datapublic-scout'),
  chain TEXT NOT NULL
    CHECK (chain IN ('robinhood', 'solana')),
  mint TEXT NOT NULL,
  mint_key TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  kind TEXT,
  decision TEXT,
  score NUMERIC,
  climate_label TEXT NOT NULL
    CHECK (climate_label = 'Safe'),
  climate_state TEXT,
  climate_at_emit_label TEXT,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT strategy_paper_notches_dedupe UNIQUE (strategy_id, chain, mint_key)
);
CREATE INDEX IF NOT EXISTS idx_strategy_paper_notches_created
  ON strategy_paper_notches (strategy_id, created_at DESC);
`

let ensurePromise: Promise<void> | null = null

export async function ensureBuybulkPaperNotchesTable(): Promise<void> {
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

export type BuybulkPaperNotchRow = {
  id: string
  strategy_id: string
  chain: ScoutChain
  mint: string
  mint_key: string
  symbol: string | null
  name: string | null
  kind: string | null
  decision: string | null
  score: number | null
  climate_label: ClimateChipLabel
  climate_state: string | null
  climate_at_emit_label: ClimateChipLabel | null
  features: Record<string, unknown> | null
  created_at: string
}

export type InsertBuybulkPaperNotchInput = {
  candidate: Pick<
    ScoutCandidate,
    'chain' | 'mint' | 'symbol' | 'name' | 'kind' | 'decision' | 'score'
  > &
    Partial<Pick<ScoutCandidate, 'id' | 'url' | 'mcap' | 'liq' | 'source'>>
  climateLabel: ClimateChipLabel | string | null | undefined
  climateState?: string | null
  climateAtEmitLabel?: ClimateChipLabel | null
  strategyId?: string | null
}

export type InsertBuybulkPaperNotchResult =
  | { ok: true; notch: PaperNotch; created: boolean }
  | {
      ok: false
      reason: 'climate_not_safe' | 'missing_mint' | 'wrong_strategy'
    }

export function paperNotchFromDbRow(row: BuybulkPaperNotchRow): PaperNotch {
  const chain = row.chain
  const mint = row.mint
  const notedAt = Date.parse(row.created_at)
  return {
    key: mintKey(chain, mint),
    strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
    chain,
    mint,
    symbol: row.symbol?.trim() || mint.slice(0, 6),
    name: row.name?.trim() || row.symbol?.trim() || mint.slice(0, 6),
    kind: row.kind || 'vetted',
    decision: row.decision,
    score:
      typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
    notedAt: Number.isFinite(notedAt) ? notedAt : 0,
    climateLabel: 'Safe',
    climateState: row.climate_state,
    climateAtEmitLabel:
      row.climate_at_emit_label === 'Safe' ||
      row.climate_at_emit_label === 'Not safe' ||
      row.climate_at_emit_label === 'Unknown'
        ? row.climate_at_emit_label
        : null,
    source: BUYBULK_DATAPUBLIC_SCOUT_ID,
  }
}

function isScoutChain(value: unknown): value is ScoutChain {
  return value === 'robinhood' || value === 'solana'
}

export async function listBuybulkPaperNotches(): Promise<PaperNotch[]> {
  await ensureBuybulkPaperNotchesTable()
  const { rows } = await query<BuybulkPaperNotchRow>(
    `SELECT id, strategy_id, chain, mint, mint_key, symbol, name, kind, decision,
            score, climate_label, climate_state, climate_at_emit_label, features, created_at
       FROM strategy_paper_notches
      WHERE strategy_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [BUYBULK_DATAPUBLIC_SCOUT_ID],
  )
  return rows.filter((r) => isScoutChain(r.chain)).map(paperNotchFromDbRow)
}

export async function insertBuybulkPaperNotch(
  input: InsertBuybulkPaperNotchInput,
): Promise<InsertBuybulkPaperNotchResult> {
  if (
    input.strategyId &&
    input.strategyId !== BUYBULK_DATAPUBLIC_SCOUT_ID
  ) {
    return { ok: false, reason: 'wrong_strategy' }
  }
  if (input.strategyId === RHTAPE_DATAPUBLIC_SCOUT_ID) {
    return { ok: false, reason: 'wrong_strategy' }
  }
  if (!canPaperNotchFromClimate(input.climateLabel)) {
    return { ok: false, reason: 'climate_not_safe' }
  }
  const mint = input.candidate.mint?.trim() ?? ''
  if (!mint) return { ok: false, reason: 'missing_mint' }
  if (!isScoutChain(input.candidate.chain)) {
    return { ok: false, reason: 'missing_mint' }
  }

  await ensureBuybulkPaperNotchesTable()
  const key = mintKey(input.candidate.chain, mint)
  const features = {
    source: 'buybulk-datapublic-scout',
    candidateId: input.candidate.id ?? null,
    url: input.candidate.url ?? null,
    mcap: input.candidate.mcap ?? null,
    liq: input.candidate.liq ?? null,
    feedSource: input.candidate.source ?? null,
  }

  const { rows } = await query<BuybulkPaperNotchRow>(
    `INSERT INTO strategy_paper_notches (
        strategy_id, chain, mint, mint_key, symbol, name, kind, decision, score,
        climate_label, climate_state, climate_at_emit_label, features
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        'Safe', $10, $11, $12::jsonb
      )
      ON CONFLICT (strategy_id, chain, mint_key) DO NOTHING
      RETURNING id, strategy_id, chain, mint, mint_key, symbol, name, kind, decision,
                score, climate_label, climate_state, climate_at_emit_label, features, created_at`,
    [
      BUYBULK_DATAPUBLIC_SCOUT_ID,
      input.candidate.chain,
      mint,
      key,
      input.candidate.symbol,
      input.candidate.name,
      input.candidate.kind,
      input.candidate.decision,
      input.candidate.score,
      input.climateState ?? null,
      input.climateAtEmitLabel ?? 'Safe',
      JSON.stringify(features),
    ],
  )

  if (rows[0] && isScoutChain(rows[0].chain)) {
    return { ok: true, notch: paperNotchFromDbRow(rows[0]), created: true }
  }

  const existing = await query<BuybulkPaperNotchRow>(
    `SELECT id, strategy_id, chain, mint, mint_key, symbol, name, kind, decision,
            score, climate_label, climate_state, climate_at_emit_label, features, created_at
       FROM strategy_paper_notches
      WHERE strategy_id = $1 AND chain = $2 AND mint_key = $3
      LIMIT 1`,
    [BUYBULK_DATAPUBLIC_SCOUT_ID, input.candidate.chain, key],
  )
  const row = existing.rows[0]
  if (row && isScoutChain(row.chain)) {
    return { ok: true, notch: paperNotchFromDbRow(row), created: false }
  }
  return { ok: true, notch: paperNotchFromDbRow({
    id: '',
    strategy_id: BUYBULK_DATAPUBLIC_SCOUT_ID,
    chain: input.candidate.chain,
    mint,
    mint_key: key,
    symbol: input.candidate.symbol,
    name: input.candidate.name,
    kind: input.candidate.kind,
    decision: input.candidate.decision,
    score: input.candidate.score,
    climate_label: 'Safe',
    climate_state: input.climateState ?? null,
    climate_at_emit_label: input.climateAtEmitLabel ?? 'Safe',
    features,
    created_at: new Date().toISOString(),
  }), created: false }
}
