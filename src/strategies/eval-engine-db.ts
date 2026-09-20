import fs from 'node:fs'
import path from 'path'
import { query, queryOne } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import type { EvalDecision, EvalScanSummary } from './eval-engine'
import {
  applyActualToPrediction,
  actualWinFromOutcome,
  summarizeRunAccuracy,
  type EvalPrediction,
  type EvalRunAccuracy,
  type OutcomeMlPrediction,
  type PredictedLabel,
} from './eval-predictions'

const LAST_RUN_PATH = 'data/ml-closed-loop/last-run.json'

let ensurePromise: Promise<void> | null = null

async function ensureEvalTables(): Promise<void> {
  if (ensurePromise) {
    await ensurePromise
    return
  }
  ensurePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS ml_eval_runs (
        id TEXT PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        mode TEXT NOT NULL,
        scanned INT NOT NULL DEFAULT 0,
        skipped INT NOT NULL DEFAULT 0,
        paper_opened INT NOT NULL DEFAULT 0,
        live_attempted INT NOT NULL DEFAULT 0,
        errors INT NOT NULL DEFAULT 0,
        summary JSONB
      )
    `)
    await query(`ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS candidate_count INT NOT NULL DEFAULT 0`)
    await query(`ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS predict_count INT NOT NULL DEFAULT 0`)
    await query(`ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS linked_count INT NOT NULL DEFAULT 0`)
    await query(`ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS accuracy DOUBLE PRECISION`)
    await query(`ALTER TABLE ml_eval_runs ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT TRUE`)
    await query(`
      CREATE TABLE IF NOT EXISTS ml_eval_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        mint TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        combined DOUBLE PRECISION,
        ml_score DOUBLE PRECISION,
        model_version TEXT,
        action TEXT NOT NULL,
        reason TEXT,
        mode TEXT NOT NULL,
        risk JSONB,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await query(`
      CREATE INDEX IF NOT EXISTS ml_eval_decisions_mint_strategy_idx
      ON ml_eval_decisions (mint, strategy_id, decided_at DESC)
    `)
    await query(`
      CREATE TABLE IF NOT EXISTS strategy_ml_predictions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        mint TEXT NOT NULL,
        token_address TEXT,
        strategy_id TEXT NOT NULL,
        predicted_label TEXT,
        predicted_ml_win BOOLEAN,
        predicted_score DOUBLE PRECISION,
        ml_score DOUBLE PRECISION,
        combined DOUBLE PRECISION,
        model_version TEXT,
        outcome_id TEXT,
        actual_label TEXT,
        actual_ml_win BOOLEAN,
        correct BOOLEAN
      )
    `)
    await query(`
      CREATE INDEX IF NOT EXISTS strategy_ml_predictions_run_idx
      ON strategy_ml_predictions (run_id, predicted_at DESC)
    `)
    await query(`
      CREATE INDEX IF NOT EXISTS strategy_ml_predictions_mint_strategy_idx
      ON strategy_ml_predictions (mint, strategy_id, predicted_at DESC)
    `)
    await query(`
      CREATE INDEX IF NOT EXISTS strategy_ml_predictions_outcome_idx
      ON strategy_ml_predictions (outcome_id)
      WHERE outcome_id IS NOT NULL
    `)
  })()
    .then(() => undefined)
    .catch((err) => {
      ensurePromise = null
      throw err
    })
  await ensurePromise
}

export async function insertEvalRun(runId: string, summary: EvalScanSummary): Promise<void> {
  try {
    await ensureEvalTables()
    await query(
      `INSERT INTO ml_eval_runs (
         id, started_at, finished_at, mode, scanned, skipped,
         paper_opened, live_attempted, errors, summary,
         candidate_count, predict_count, linked_count, shadow
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET
         finished_at = EXCLUDED.finished_at,
         scanned = EXCLUDED.scanned,
         skipped = EXCLUDED.skipped,
         paper_opened = EXCLUDED.paper_opened,
         live_attempted = EXCLUDED.live_attempted,
         errors = EXCLUDED.errors,
         summary = EXCLUDED.summary,
         candidate_count = EXCLUDED.candidate_count,
         predict_count = EXCLUDED.predict_count,
         linked_count = EXCLUDED.linked_count,
         shadow = EXCLUDED.shadow`,
      [
        runId,
        summary.finishedAt,
        summary.finishedAt,
        summary.mode,
        summary.scanned,
        summary.skipped,
        summary.paperOpened,
        summary.liveAttempted,
        summary.errors,
        JSON.stringify(summary),
        summary.scanned,
        summary.predictCount,
        summary.linkedCount,
        summary.shadow,
      ],
    )
  } catch (error) {
    if (isMissingSchemaError(error)) return
    throw error
  }
}

export async function insertEvalDecisions(
  runId: string,
  decisions: EvalDecision[],
): Promise<void> {
  if (decisions.length === 0) return
  try {
    await ensureEvalTables()
    for (const [i, d] of decisions.entries()) {
      await query(
        `INSERT INTO ml_eval_decisions (
           id, run_id, mint, strategy_id, combined, ml_score, model_version,
           action, reason, mode, risk, decided_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
         ON CONFLICT (id) DO NOTHING`,
        [
          `${runId}-${i}-${d.mint.slice(0, 8)}`,
          runId,
          d.mint,
          d.strategyId,
          d.combined,
          d.mlScore,
          d.modelVersion,
          d.action,
          d.reason,
          d.mode,
          d.risk ? JSON.stringify(d.risk) : null,
          d.decidedAt,
        ],
      )
    }
  } catch (error) {
    if (isMissingSchemaError(error)) return
    throw error
  }
}

export async function insertMlPredictions(predictions: EvalPrediction[]): Promise<void> {
  if (predictions.length === 0) return
  try {
    await ensureEvalTables()
    for (const p of predictions) {
      await query(
        `INSERT INTO strategy_ml_predictions (
           id, run_id, predicted_at, mint, token_address, strategy_id,
           predicted_label, predicted_ml_win, predicted_score, ml_score, combined,
           model_version, outcome_id, actual_label, actual_ml_win, correct
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id,
          p.runId,
          p.predictedAt,
          p.mint,
          p.tokenAddress,
          p.strategyId,
          p.predictedLabel,
          p.predictedMlWin,
          p.predictedScore,
          p.mlScore,
          p.combined,
          p.modelVersion,
          p.outcomeId,
          p.actualLabel,
          p.actualMlWin,
          p.correct,
        ],
      )
    }
  } catch (error) {
    if (isMissingSchemaError(error)) return
    throw error
  }
}

type OutcomeMatch = {
  id: string
  features: Record<string, unknown> | null
  pnl_pct: number | null
  status: string | null
}

function parseFeatures(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return null
}

async function findLatestOutcome(
  mint: string,
  strategyId: string,
): Promise<OutcomeMatch | null> {
  const row = await queryOne<{
    id: string
    features: unknown
    pnl_pct: number | null
    status: string | null
  }>(
    `SELECT id, features, pnl_pct, status
     FROM strategy_outcomes
     WHERE strategy_id = $1
       AND (token_address = $2 OR token_address = $3)
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1`,
    [strategyId, mint, mint.toLowerCase()],
  )
  if (!row) return null
  return {
    id: String(row.id),
    features: parseFeatures(row.features),
    pnl_pct: row.pnl_pct != null ? Number(row.pnl_pct) : null,
    status: row.status != null ? String(row.status) : null,
  }
}

async function applyOutcomeToPredictionRow(
  predictionId: string,
  outcome: OutcomeMatch,
): Promise<boolean> {
  const actualMlWin = actualWinFromOutcome(outcome.features, outcome.pnl_pct, outcome.status)
  const pred = await queryOne<{ predicted_ml_win: boolean | null }>(
    `SELECT predicted_ml_win FROM strategy_ml_predictions WHERE id = $1`,
    [predictionId],
  )
  const predictedMlWin = pred?.predicted_ml_win === true
  const applied = applyActualToPrediction(predictedMlWin, actualMlWin)
  await query(
    `UPDATE strategy_ml_predictions
     SET outcome_id = $2,
         actual_label = $3,
         actual_ml_win = $4,
         correct = $5
     WHERE id = $1`,
    [predictionId, outcome.id, applied.actualLabel, applied.actualMlWin, applied.correct],
  )
  if (actualMlWin != null) {
    await stampOutcomePrediction(outcome.id, predictionId)
  }
  return applied.correct != null
}

async function stampOutcomePrediction(outcomeId: string, predictionId: string): Promise<void> {
  const pred = await queryOne<{
    predicted_label: string | null
    predicted_score: number | null
    predicted_ml_win: boolean | null
    model_version: string | null
    run_id: string
  }>(
    `SELECT predicted_label, predicted_score, predicted_ml_win, model_version, run_id
     FROM strategy_ml_predictions WHERE id = $1`,
    [predictionId],
  )
  if (!pred) return
  const patch = {
    ml_predicted_label: pred.predicted_label,
    ml_predicted_score: pred.predicted_score,
    ml_predicted_ml_win: pred.predicted_ml_win,
    ml_predicted_model_version: pred.model_version,
    ml_predicted_run_id: pred.run_id,
  }
  await query(
    `UPDATE strategy_outcomes
     SET features = COALESCE(features, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [outcomeId, JSON.stringify(patch)],
  ).catch(() => undefined)
}

export async function linkPredictionsForRun(runId: string): Promise<number> {
  try {
    await ensureEvalTables()
    const { rows } = await query<{
      id: string
      mint: string
      strategy_id: string
    }>(
      `SELECT id, mint, strategy_id
       FROM strategy_ml_predictions
       WHERE run_id = $1 AND outcome_id IS NULL`,
      [runId],
    )
    let linked = 0
    for (const row of rows) {
      const outcome = await findLatestOutcome(row.mint, row.strategy_id)
      if (!outcome) continue
      await applyOutcomeToPredictionRow(row.id, outcome)
      linked += 1
    }
    return linked
  } catch (error) {
    if (isMissingSchemaError(error)) return 0
    return 0
  }
}

export async function resolvePredictionsForClosedOutcome(params: {
  outcomeId: string
  mint: string
  strategyId: string
  features?: Record<string, unknown> | null
  pnlPct?: number | null
  status?: string | null
}): Promise<number> {
  if (!params.mint || !params.strategyId || !params.outcomeId) return 0
  try {
    await ensureEvalTables()
    const actualMlWin = actualWinFromOutcome(params.features, params.pnlPct, params.status)
    const { rows } = await query<{ id: string; predicted_ml_win: boolean | null; run_id: string }>(
      `SELECT id, predicted_ml_win, run_id
       FROM strategy_ml_predictions
       WHERE strategy_id = $1
         AND (mint = $2 OR token_address = $2)
         AND (actual_ml_win IS NULL OR outcome_id IS NULL)`,
      [params.strategyId, params.mint],
    )
    if (rows.length === 0) return 0
    const runIds = new Set<string>()
    let updated = 0
    for (const row of rows) {
      const applied = applyActualToPrediction(row.predicted_ml_win === true, actualMlWin)
      await query(
        `UPDATE strategy_ml_predictions
         SET outcome_id = $2,
             actual_label = $3,
             actual_ml_win = $4,
             correct = $5
         WHERE id = $1`,
        [row.id, params.outcomeId, applied.actualLabel, applied.actualMlWin, applied.correct],
      )
      if (applied.correct != null) {
        await stampOutcomePrediction(params.outcomeId, row.id)
      }
      runIds.add(row.run_id)
      updated += 1
    }
    for (const runId of runIds) {
      await rollupEvalRunAccuracy(runId)
    }
    return updated
  } catch (error) {
    if (isMissingSchemaError(error)) return 0
    console.warn(
      '[eval-engine] resolve predictions failed:',
      error instanceof Error ? error.message : String(error),
    )
    return 0
  }
}

export async function rollupEvalRunAccuracy(runId: string): Promise<EvalRunAccuracy | null> {
  try {
    await ensureEvalTables()
    const { rows } = await query<{
      predicted_score: number | null
      actual_ml_win: boolean | null
      correct: boolean | null
    }>(
      `SELECT predicted_score, actual_ml_win, correct
       FROM strategy_ml_predictions WHERE run_id = $1`,
      [runId],
    )
    const run = await queryOne<{
      started_at: string | null
      finished_at: string | null
      scanned: number
      predict_count: number
      shadow: boolean | null
      mode: string | null
    }>(
      `SELECT started_at, finished_at, scanned, predict_count, shadow, mode
       FROM ml_eval_runs WHERE id = $1`,
      [runId],
    )
    const linked = rows.filter((r) => r.actual_ml_win != null).length
    const stats = summarizeRunAccuracy(rows, {
      runId,
      startedAt: run?.started_at ?? null,
      finishedAt: run?.finished_at ?? null,
      candidateCount: run?.scanned ?? rows.length,
      predictCount: run?.predict_count ?? rows.length,
      linkedCount: linked,
      shadow: run?.shadow !== false,
      mode: run?.mode ?? null,
    })
    await query(
      `UPDATE ml_eval_runs
       SET linked_count = $2, accuracy = $3
       WHERE id = $1`,
      [runId, stats.linkedCount, stats.accuracy],
    )
    return stats
  } catch (error) {
    if (isMissingSchemaError(error)) return null
    return null
  }
}

function mapPredictionRow(row: {
  id: string
  run_id: string
  predicted_at: string
  mint: string
  token_address: string | null
  strategy_id: string
  predicted_label: string | null
  predicted_ml_win: boolean | null
  predicted_score: number | null
  ml_score: number | null
  combined: number | null
  model_version: string | null
  outcome_id: string | null
  actual_label: string | null
  actual_ml_win: boolean | null
  correct: boolean | null
}): EvalPrediction {
  const predictedLabel: PredictedLabel = row.predicted_label === 'loss' ? 'loss' : 'win'
  const actualLabel: PredictedLabel | null =
    row.actual_label === 'win' || row.actual_label === 'loss' ? row.actual_label : null
  return {
    id: row.id,
    runId: row.run_id,
    predictedAt: row.predicted_at,
    mint: row.mint,
    tokenAddress: row.token_address ?? row.mint,
    strategyId: row.strategy_id,
    predictedLabel,
    predictedMlWin: row.predicted_ml_win === true,
    predictedScore: row.predicted_score,
    mlScore: row.ml_score,
    combined: row.combined,
    modelVersion: row.model_version,
    outcomeId: row.outcome_id,
    actualLabel,
    actualMlWin: row.actual_ml_win,
    correct: row.correct,
  }
}

export async function loadMlPredictionsForRun(runId: string): Promise<EvalPrediction[]> {
  try {
    await ensureEvalTables()
    const { rows } = await query<{
      id: string
      run_id: string
      predicted_at: string
      mint: string
      token_address: string | null
      strategy_id: string
      predicted_label: string | null
      predicted_ml_win: boolean | null
      predicted_score: number | null
      ml_score: number | null
      combined: number | null
      model_version: string | null
      outcome_id: string | null
      actual_label: string | null
      actual_ml_win: boolean | null
      correct: boolean | null
    }>(
      `SELECT id, run_id, predicted_at, mint, token_address, strategy_id,
              predicted_label, predicted_ml_win, predicted_score, ml_score, combined,
              model_version, outcome_id, actual_label, actual_ml_win, correct
       FROM strategy_ml_predictions
       WHERE run_id = $1
       ORDER BY predicted_at DESC`,
      [runId],
    )
    return rows.map(mapPredictionRow)
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    return []
  }
}

export async function loadEvalRunAccuracy(runId: string): Promise<EvalRunAccuracy | null> {
  return rollupEvalRunAccuracy(runId)
}

export async function loadEvalRunAccuracySince(sinceIso: string): Promise<EvalRunAccuracy[]> {
  try {
    await ensureEvalTables()
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM ml_eval_runs
       WHERE COALESCE(finished_at, started_at) >= $1
       ORDER BY finished_at DESC NULLS LAST
       LIMIT 50`,
      [sinceIso],
    )
    const out: EvalRunAccuracy[] = []
    for (const row of rows) {
      const stats = await rollupEvalRunAccuracy(row.id)
      if (stats) out.push(stats)
    }
    return out
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    return []
  }
}

export async function attachMlPredictionsToOutcomes<
  T extends { id: string; strategy_id: string; token_address: string | null; features?: Record<string, unknown> | null },
>(
  rows: T[],
): Promise<Array<T & { ml_prediction: OutcomeMlPrediction | null }>> {
  if (rows.length === 0) return []
  try {
    await ensureEvalTables()
    const mints = Array.from(
      new Set(rows.map((r) => r.token_address).filter((v): v is string => !!v)),
    )
    const strategyIds = Array.from(new Set(rows.map((r) => r.strategy_id)))
    if (mints.length === 0 || strategyIds.length === 0) {
      return rows.map((row) => ({
        ...row,
        ml_prediction: predictionFromFeatures(row.features),
      }))
    }
    const { rows: preds } = await query<{
      mint: string
      token_address: string | null
      strategy_id: string
      outcome_id: string | null
      predicted_label: string | null
      predicted_score: number | null
      predicted_ml_win: boolean | null
      model_version: string | null
      actual_ml_win: boolean | null
      correct: boolean | null
      run_id: string
      predicted_at: string
    }>(
      `SELECT DISTINCT ON (strategy_id, mint)
              mint, token_address, strategy_id, outcome_id, predicted_label, predicted_score,
              predicted_ml_win, model_version, actual_ml_win, correct, run_id, predicted_at
       FROM strategy_ml_predictions
       WHERE strategy_id = ANY($1::text[])
         AND (mint = ANY($2::text[]) OR token_address = ANY($2::text[]))
       ORDER BY strategy_id, mint, predicted_at DESC`,
      [strategyIds, mints],
    )
    const byOutcome = new Map<string, OutcomeMlPrediction>()
    const byKey = new Map<string, OutcomeMlPrediction>()
    for (const p of preds) {
      const badge: OutcomeMlPrediction = {
        predicted_label: p.predicted_label === 'loss' ? 'loss' : p.predicted_label === 'win' ? 'win' : null,
        predicted_score: p.predicted_score,
        predicted_ml_win: p.predicted_ml_win,
        model_version: p.model_version,
        actual_ml_win: p.actual_ml_win,
        correct: p.correct,
        run_id: p.run_id,
      }
      if (p.outcome_id) byOutcome.set(p.outcome_id, badge)
      byKey.set(`${p.strategy_id}:${p.mint}`, badge)
      if (p.token_address) byKey.set(`${p.strategy_id}:${p.token_address}`, badge)
    }
    return rows.map((row) => {
      const fromTable =
        byOutcome.get(row.id) ??
        (row.token_address ? byKey.get(`${row.strategy_id}:${row.token_address}`) : undefined) ??
        null
      return {
        ...row,
        ml_prediction: fromTable ?? predictionFromFeatures(row.features),
      }
    })
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return rows.map((row) => ({
        ...row,
        ml_prediction: predictionFromFeatures(row.features),
      }))
    }
    return rows.map((row) => ({
      ...row,
      ml_prediction: predictionFromFeatures(row.features),
    }))
  }
}

function predictionFromFeatures(
  features: Record<string, unknown> | null | undefined,
): OutcomeMlPrediction | null {
  if (!features) return null
  const label = features.ml_predicted_label
  const score = features.ml_predicted_score
  if (label !== 'win' && label !== 'loss' && (typeof score !== 'number' || !Number.isFinite(score))) {
    return null
  }
  return {
    predicted_label: label === 'win' || label === 'loss' ? label : null,
    predicted_score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    predicted_ml_win:
      features.ml_predicted_ml_win === true || features.ml_predicted_ml_win === 1
        ? true
        : features.ml_predicted_ml_win === false || features.ml_predicted_ml_win === 0
          ? false
          : null,
    model_version:
      typeof features.ml_predicted_model_version === 'string'
        ? features.ml_predicted_model_version
        : null,
    actual_ml_win:
      features.ml_win === 1 || features.ml_win === true
        ? true
        : features.ml_win === 0 || features.ml_win === false
          ? false
          : null,
    correct: typeof features.ml_predicted_correct === 'boolean' ? features.ml_predicted_correct : null,
    run_id: typeof features.ml_predicted_run_id === 'string' ? features.ml_predicted_run_id : null,
  }
}

export async function loadLatestEvalRun(): Promise<EvalScanSummary | null> {
  try {
    await ensureEvalTables()
    const row = await queryOne<{ summary: EvalScanSummary | string }>(
      `SELECT summary FROM ml_eval_runs ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    )
    if (!row?.summary) return null
    return typeof row.summary === 'string'
      ? (JSON.parse(row.summary) as EvalScanSummary)
      : row.summary
  } catch (error) {
    if (isMissingSchemaError(error)) return null
    return null
  }
}

export async function loadEvalDecisionsSince(sinceIso: string): Promise<EvalDecision[]> {
  try {
    await ensureEvalTables()
    const { rows } = await query<{
      mint: string
      strategy_id: string
      combined: number | null
      ml_score: number | null
      model_version: string | null
      action: EvalDecision['action']
      reason: string | null
      mode: EvalDecision['mode']
      risk: EvalDecision['risk'] | string | null
      decided_at: string
    }>(
      `SELECT mint, strategy_id, combined, ml_score, model_version, action, reason, mode, risk, decided_at
       FROM ml_eval_decisions
       WHERE decided_at >= $1`,
      [sinceIso],
    )
    return rows.map((row) => ({
      mint: row.mint,
      strategyId: row.strategy_id,
      combined: row.combined,
      mlScore: row.ml_score,
      modelVersion: row.model_version,
      action: row.action,
      reason: row.reason ?? '',
      mode: row.mode,
      risk:
        typeof row.risk === 'string'
          ? (JSON.parse(row.risk) as EvalDecision['risk'])
          : row.risk,
      decidedAt: row.decided_at,
    }))
  } catch (error) {
    if (isMissingSchemaError(error)) return []
    return []
  }
}

export function saveEvalLastRun(summary: EvalScanSummary, decisionCount: number): void {
  const dir = path.dirname(LAST_RUN_PATH)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    LAST_RUN_PATH,
    `${JSON.stringify({ ...summary, decisionCount }, null, 2)}\n`,
    'utf8',
  )
}

export function loadEvalLastRunFile(): EvalScanSummary | null {
  try {
    if (!fs.existsSync(/* turbopackIgnore: true */ LAST_RUN_PATH)) return null
    const raw = JSON.parse(fs.readFileSync(LAST_RUN_PATH, 'utf8')) as EvalScanSummary
    if (!raw || typeof raw.runId !== 'string') return null
    return raw
  } catch {
    return null
  }
}
