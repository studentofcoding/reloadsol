/**
 * Shadow eval predictions — score + label without opening.
 * Actuals land when a strategy_outcomes row closes or labels backfill.
 */
import { computeTrainingClass } from './outcome-labeling'
import {
  DEFAULT_ML_PAPER_MIN_COMBINED,
  DEFAULT_ML_PAPER_MIN_ML,
  type EvalAction,
  type EvalDecision,
} from './eval-engine'

export type PredictedLabel = 'win' | 'loss'

export type EvalPrediction = {
  id: string
  runId: string
  predictedAt: string
  mint: string
  tokenAddress: string
  strategyId: string
  predictedLabel: PredictedLabel
  predictedMlWin: boolean
  predictedScore: number | null
  mlScore: number | null
  combined: number | null
  modelVersion: string | null
  outcomeId: string | null
  actualLabel: PredictedLabel | null
  actualMlWin: boolean | null
  correct: boolean | null
}

export type EvalRunAccuracy = {
  runId: string
  startedAt: string | null
  finishedAt: string | null
  candidateCount: number
  predictCount: number
  linkedCount: number
  resolved: number
  correct: number
  accuracy: number | null
  avgPredictedScoreWins: number | null
  avgPredictedScoreLosses: number | null
  shadow: boolean
  mode: string | null
}

export type OutcomeMlPrediction = {
  predicted_label: PredictedLabel | null
  predicted_score: number | null
  predicted_ml_win: boolean | null
  model_version: string | null
  actual_ml_win: boolean | null
  correct: boolean | null
  run_id: string | null
}

const PREDICT_ACTIONS: ReadonlySet<EvalAction> = new Set([
  'shadow_predict',
  'paper_open',
  'live_open',
])

export function isPredictAction(action: EvalAction): boolean {
  return PREDICT_ACTIONS.has(action)
}

export function scoreForPrediction(
  mlScore: number | null | undefined,
  combined: number | null | undefined,
): number | null {
  if (mlScore != null && Number.isFinite(mlScore)) return mlScore
  if (combined != null && Number.isFinite(combined)) return combined
  return null
}

export function hasPredictionScore(
  mlScore: number | null | undefined,
  combined: number | null | undefined,
): boolean {
  return scoreForPrediction(mlScore, combined) != null
}

export function predictedWinFromScores(
  mlScore: number | null | undefined,
  combined: number | null | undefined,
  opts?: { minMl?: number; minCombined?: number },
): boolean {
  const minMl = opts?.minMl ?? DEFAULT_ML_PAPER_MIN_ML
  const minCombined = opts?.minCombined ?? DEFAULT_ML_PAPER_MIN_COMBINED
  if (mlScore != null && Number.isFinite(mlScore)) return mlScore >= minMl
  if (combined != null && Number.isFinite(combined)) return combined >= minCombined
  return false
}

export function actualWinFromOutcome(
  features: Record<string, unknown> | null | undefined,
  pnlPct?: number | null,
  status?: string | null,
): boolean | null {
  const raw = features?.ml_win
  if (raw === 1 || raw === true) return true
  if (raw === 0 || raw === false) return false
  const tc = computeTrainingClass(pnlPct, status)
  if (tc == null) return null
  return tc >= 1
}

export function applyActualToPrediction(
  predictedMlWin: boolean,
  actualMlWin: boolean | null,
): {
  actualLabel: PredictedLabel | null
  actualMlWin: boolean | null
  correct: boolean | null
} {
  if (actualMlWin == null) {
    return { actualLabel: null, actualMlWin: null, correct: null }
  }
  return {
    actualLabel: actualMlWin ? 'win' : 'loss',
    actualMlWin,
    correct: predictedMlWin === actualMlWin,
  }
}

export function buildPredictionFromDecision(
  runId: string,
  decision: EvalDecision,
  opts?: { id?: string; minMl?: number; minCombined?: number },
): EvalPrediction | null {
  if (!isPredictAction(decision.action)) return null
  if (!hasPredictionScore(decision.mlScore, decision.combined)) return null
  const predictedMlWin = predictedWinFromScores(decision.mlScore, decision.combined, opts)
  return {
    id: opts?.id ?? `${runId}:${decision.strategyId}:${decision.mint}`,
    runId,
    predictedAt: decision.decidedAt,
    mint: decision.mint,
    tokenAddress: decision.mint,
    strategyId: decision.strategyId,
    predictedLabel: predictedMlWin ? 'win' : 'loss',
    predictedMlWin,
    predictedScore: scoreForPrediction(decision.mlScore, decision.combined),
    mlScore: decision.mlScore,
    combined: decision.combined,
    modelVersion: decision.modelVersion,
    outcomeId: null,
    actualLabel: null,
    actualMlWin: null,
    correct: null,
  }
}

export function summarizeRunAccuracy(
  rows: Array<{
    predictedScore?: number | null
    predicted_score?: number | null
    actualMlWin?: boolean | null
    actual_ml_win?: boolean | null
    correct?: boolean | null
  }>,
  extras: Partial<EvalRunAccuracy> & Pick<EvalRunAccuracy, 'runId'> = { runId: '' },
): EvalRunAccuracy {
  const resolved = rows.filter((row) => {
    const actual = row.actualMlWin ?? row.actual_ml_win
    return actual != null && row.correct != null
  })
  const correctN = resolved.filter((row) => row.correct === true).length
  const winScores = resolved
    .filter((row) => (row.actualMlWin ?? row.actual_ml_win) === true)
    .map((row) => row.predictedScore ?? row.predicted_score)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  const lossScores = resolved
    .filter((row) => (row.actualMlWin ?? row.actual_ml_win) === false)
    .map((row) => row.predictedScore ?? row.predicted_score)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  const avg = (xs: number[]) =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    runId: extras.runId,
    startedAt: extras.startedAt ?? null,
    finishedAt: extras.finishedAt ?? null,
    candidateCount: extras.candidateCount ?? rows.length,
    predictCount: extras.predictCount ?? rows.length,
    linkedCount: extras.linkedCount ?? resolved.length,
    resolved: resolved.length,
    correct: correctN,
    accuracy: resolved.length === 0 ? null : correctN / resolved.length,
    avgPredictedScoreWins: avg(winScores),
    avgPredictedScoreLosses: avg(lossScores),
    shadow: extras.shadow ?? true,
    mode: extras.mode ?? null,
  }
}

export function predictionToOutcomeBadge(pred: EvalPrediction | null): OutcomeMlPrediction | null {
  if (!pred) return null
  return {
    predicted_label: pred.predictedLabel,
    predicted_score: pred.predictedScore,
    predicted_ml_win: pred.predictedMlWin,
    model_version: pred.modelVersion,
    actual_ml_win: pred.actualMlWin,
    correct: pred.correct,
    run_id: pred.runId,
  }
}
