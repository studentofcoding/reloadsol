/**
 * Phase 4 eval engine — decide skip | shadow_predict | paper_open | live_open.
 *
 * Shadow is the default: score + log predictions, never auto-open.
 * Paper opens (EVAL_SHADOW=0 + EVAL_ENGINE=1) go through PaperExecutionAdapter
 * (sim-track + score→risk). Live is a stub: both EVAL_EXEC_MODE=live and
 * LIVE_TRADE_ENABLED=1 required, and even then v1 does not call a broker.
 */
import { isClosedLoopPrincipalId, isMlClosedLoopEnabled } from './closed-loop-ml'

export type EvalAction = 'skip' | 'shadow_predict' | 'paper_open' | 'live_open'
export type EvalExecMode = 'paper' | 'live'

export type EvalRiskSnapshot = {
  takeProfitPct: number
  stopLossPct: number
  holdHours: number
  autoSl: boolean
  riskSource: string
}

export type EvalDecision = {
  mint: string
  strategyId: string
  combined: number | null
  mlScore: number | null
  modelVersion: string | null
  action: EvalAction
  risk: EvalRiskSnapshot | null
  reason: string
  mode: EvalExecMode
  decidedAt: string
}

export type EvalDecideInput = {
  mint: string
  strategyId: string
  combined: number | null
  mlScore: number | null
  modelVersion?: string | null
  alreadyOpen?: boolean
  alreadyClosed?: boolean
  eligible?: boolean
  eligibilityReason?: string | null
  now?: Date
}

export const DEFAULT_ML_PAPER_MIN_COMBINED = 0.35
export const DEFAULT_ML_PAPER_MIN_ML = 0.5

export function isEvalEngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.EVAL_ENGINE?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** Shadow is on unless EVAL_SHADOW is explicitly 0/false/no/off. */
export function isEvalShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.EVAL_SHADOW?.trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return true
}

/** Paper/live opens only when the engine is on and shadow is explicitly off. */
export function allowsEvalOpens(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEvalEngineEnabled(env) && !isEvalShadowEnabled(env)
}

export function getEvalExecMode(env: NodeJS.ProcessEnv = process.env): EvalExecMode {
  return env.EVAL_EXEC_MODE?.trim().toLowerCase() === 'live' ? 'live' : 'paper'
}

export function isLiveTradeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.LIVE_TRADE_ENABLED?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export function getMlPaperMinCombined(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ML_PAPER_MIN_COMBINED)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_ML_PAPER_MIN_COMBINED
}

export function getMlPaperMinMl(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ML_PAPER_MIN_ML)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_ML_PAPER_MIN_ML
}

export function evalLiveGateError(env: NodeJS.ProcessEnv = process.env): string | null {
  if (getEvalExecMode(env) !== 'live' || !isLiveTradeEnabled(env)) {
    return 'LIVE_NOT_ENABLED'
  }
  return null
}

export type EvalDecideOptions = {
  env?: NodeJS.ProcessEnv
  minCombined?: number
  minMl?: number
}

export function decideEvalAction(
  input: EvalDecideInput,
  opts: EvalDecideOptions = {},
): Pick<EvalDecision, 'action' | 'reason' | 'mode'> {
  const env = opts.env ?? process.env
  const mode = getEvalExecMode(env)
  const minCombined = opts.minCombined ?? getMlPaperMinCombined(env)
  const minMl = opts.minMl ?? getMlPaperMinMl(env)

  if (!isClosedLoopPrincipalId(input.strategyId)) {
    return { action: 'skip', reason: 'not_principal', mode }
  }
  if (input.alreadyOpen) {
    if (isEvalShadowEnabled(env) && hasDecisionScore(input)) {
      return { action: 'shadow_predict', reason: 'already_open', mode }
    }
    return { action: 'skip', reason: 'already_open', mode }
  }
  if (input.alreadyClosed) {
    if (isEvalShadowEnabled(env) && hasDecisionScore(input)) {
      return { action: 'shadow_predict', reason: 'already_closed', mode }
    }
    return { action: 'skip', reason: 'already_closed', mode }
  }
  if (input.eligible === false) {
    return { action: 'skip', reason: input.eligibilityReason ?? 'not_eligible', mode }
  }

  const combined = input.combined
  if (combined == null || !Number.isFinite(combined)) {
    return { action: 'skip', reason: 'no_combined', mode }
  }
  if (combined < minCombined) {
    return { action: 'skip', reason: 'low_combined', mode }
  }

  const mlOn = isMlClosedLoopEnabled(env)
  if (mlOn && input.mlScore != null && Number.isFinite(input.mlScore) && input.mlScore < minMl) {
    return { action: 'skip', reason: 'low_ml', mode }
  }

  if (mode === 'live') {
    return shadowOrOpen('live_open', 'opened', mode, env)
  }
  return shadowOrOpen('paper_open', 'opened', mode, env)
}

function shadowOrOpen(
  action: 'paper_open' | 'live_open',
  reason: string,
  mode: EvalExecMode,
  env: NodeJS.ProcessEnv,
): Pick<EvalDecision, 'action' | 'reason' | 'mode'> {
  if (!allowsEvalOpens(env)) {
    return { action: 'shadow_predict', reason: 'predicted', mode }
  }
  return { action, reason, mode }
}

function hasDecisionScore(input: EvalDecideInput): boolean {
  return (
    (input.mlScore != null && Number.isFinite(input.mlScore)) ||
    (input.combined != null && Number.isFinite(input.combined))
  )
}

export function buildEvalDecision(
  input: EvalDecideInput,
  opts: EvalDecideOptions = {},
): EvalDecision {
  const decided = decideEvalAction(input, opts)
  return {
    mint: input.mint,
    strategyId: input.strategyId,
    combined: input.combined,
    mlScore: input.mlScore,
    modelVersion: input.modelVersion ?? null,
    action: decided.action,
    risk: null,
    reason: decided.reason,
    mode: decided.mode,
    decidedAt: (input.now ?? new Date()).toISOString(),
  }
}

export type ExecutionAdapterResult = {
  ok: boolean
  error?: string
  opened?: boolean
  risk?: EvalRiskSnapshot | null
}

export type ExecutionAdapter = {
  open(decision: EvalDecision): Promise<ExecutionAdapterResult>
  close(decision: EvalDecision): Promise<ExecutionAdapterResult>
}

export const LIVE_NOT_ENABLED = 'LIVE_NOT_ENABLED'
export const LIVE_STUB_NO_BROKER = 'LIVE_STUB_NO_BROKER'

export type EvalReportBucket = {
  n: number
  wins: number
  losses: number
  winRate: number | null
  avgPnl: number | null
  avgWin: number | null
  avgLoss: number | null
}

export type EvalReport = {
  days: number
  decisions: {
    total: number
    skip: number
    paper_open: number
    live_open: number
    shadow_predict: number
    openRate: number
  }
  evalTagged: EvalReportBucket
  baseline: EvalReportBucket
}

export function emptyEvalBucket(): EvalReportBucket {
  return {
    n: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    avgPnl: null,
    avgWin: null,
    avgLoss: null,
  }
}

export function summarizeOutcomeBucket(
  rows: Array<{ pnl_pct?: number | null; status?: string | null }>,
): EvalReportBucket {
  const pnls = rows
    .map((r) => r.pnl_pct)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  const wins = pnls.filter((p) => p >= 0).length
  const losses = pnls.filter((p) => p < 0).length
  const winPnls = pnls.filter((p) => p >= 0)
  const lossPnls = pnls.filter((p) => p < 0)
  const avg = (xs: number[]) =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    n: rows.length,
    wins,
    losses,
    winRate: pnls.length === 0 ? null : wins / pnls.length,
    avgPnl: avg(pnls),
    avgWin: avg(winPnls),
    avgLoss: avg(lossPnls),
  }
}

export function buildEvalReport(params: {
  days: number
  decisions: Array<{ action: EvalAction }>
  evalOutcomes: Array<{ pnl_pct?: number | null; status?: string | null }>
  baselineOutcomes: Array<{ pnl_pct?: number | null; status?: string | null }>
}): EvalReport {
  const skip = params.decisions.filter((d) => d.action === 'skip').length
  const paper = params.decisions.filter((d) => d.action === 'paper_open').length
  const live = params.decisions.filter((d) => d.action === 'live_open').length
  const shadow = params.decisions.filter((d) => d.action === 'shadow_predict').length
  const total = params.decisions.length
  return {
    days: params.days,
    decisions: {
      total,
      skip,
      paper_open: paper,
      live_open: live,
      shadow_predict: shadow,
      openRate: total === 0 ? 0 : (paper + live) / total,
    },
    evalTagged: summarizeOutcomeBucket(params.evalOutcomes),
    baseline: summarizeOutcomeBucket(params.baselineOutcomes),
  }
}

export type EvalScanSummary = {
  enabled: boolean
  shadow: boolean
  mode: EvalExecMode
  runId: string
  scanned: number
  skipped: number
  paperOpened: number
  liveAttempted: number
  predictCount: number
  linkedCount: number
  errors: number
  finishedAt: string
}
