import fs from 'node:fs'
import path from 'path'
import { query, queryOne } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import type { EvalDecision, EvalScanSummary } from './eval-engine'

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
         paper_opened, live_attempted, errors, summary
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         finished_at = EXCLUDED.finished_at,
         scanned = EXCLUDED.scanned,
         skipped = EXCLUDED.skipped,
         paper_opened = EXCLUDED.paper_opened,
         live_attempted = EXCLUDED.live_attempted,
         errors = EXCLUDED.errors,
         summary = EXCLUDED.summary`,
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
