/**
 * Candidate scan + persist for the eval engine.
 * Default is shadow: score + log predictions, never auto-open.
 */
import { randomUUID } from 'crypto'
import { loadCombinedScore } from './combined-score-load'
import { isClosedLoopPrincipalId } from './closed-loop-ml'
import {
  buildEvalDecision,
  DEFAULT_EVAL_SCAN_LIMIT,
  getEvalExecMode,
  isEvalEngineEnabled,
  isEvalShadowEnabled,
  selectDiverseEvalCandidates,
  type EvalDecision,
  type EvalRiskSnapshot,
  type EvalScanSummary,
} from './eval-engine'
import { buildPredictionFromDecision, isPredictAction } from './eval-predictions'
import {
  selectExecutionAdapter,
  type PaperExecutionDeps,
} from './eval-execution'
import type { CombinedScoreChain } from './combined-score'
import type { StrategyChain } from './types'

export type EvalScanDeps = {
  loadCombinedScore?: typeof loadCombinedScore
  listCandidates?: typeof listEvalCandidates
  paper?: PaperExecutionDeps
  persist?: (
    runId: string,
    summary: EvalScanSummary,
    decisions: EvalDecision[],
  ) => Promise<void | { linkedCount?: number }>
  now?: Date
  env?: NodeJS.ProcessEnv
  limit?: number
}

export type EvalCandidate = {
  mint: string
  strategyId: string
  chain: CombinedScoreChain
  alreadyOpen: boolean
  alreadyClosed: boolean
  eligible: boolean
  eligibilityReason: string | null
}

export async function runEvalScan(deps: EvalScanDeps = {}): Promise<{
  summary: EvalScanSummary
  decisions: EvalDecision[]
}> {
  const env = deps.env ?? process.env
  const now = deps.now ?? new Date()
  const mode = getEvalExecMode(env)
  const shadow = isEvalShadowEnabled(env)
  const runId = randomUUID()
  const empty = (extras: Partial<EvalScanSummary> = {}): EvalScanSummary => ({
    enabled: isEvalEngineEnabled(env),
    shadow,
    mode,
    runId,
    scanned: 0,
    skipped: 0,
    paperOpened: 0,
    liveAttempted: 0,
    predictCount: 0,
    linkedCount: 0,
    errors: 0,
    finishedAt: now.toISOString(),
    ...extras,
  })

  if (!isEvalEngineEnabled(env)) {
    const summary = empty()
    await (deps.persist ?? persistEvalRun)(runId, summary, [])
    return { summary, decisions: [] }
  }

  const list = deps.listCandidates ?? listEvalCandidates
  const candidates = await list({ limit: deps.limit ?? DEFAULT_EVAL_SCAN_LIMIT })
  const scoreFn = deps.loadCombinedScore ?? loadCombinedScore
  const adapter = selectExecutionAdapter(mode, deps.paper, env)
  const decisions: EvalDecision[] = []
  let skipped = 0
  let paperOpened = 0
  let liveAttempted = 0
  let errors = 0

  for (const candidate of candidates) {
    let combined: number | null = null
    let mlScore: number | null = null
    let modelVersion: string | null = null
    let rugTrip = false
    try {
      const payload = await scoreFn({
        address: candidate.mint,
        chain: candidate.chain,
        hours: 24,
      })
      combined = payload.combined
      mlScore = payload.mlScore ?? null
      modelVersion = payload.modelVersion ?? null
      rugTrip = payload.rugTrip === true
    } catch {
      errors += 1
    }

    const decision = buildEvalDecision(
      {
        mint: candidate.mint,
        strategyId: candidate.strategyId,
        combined,
        mlScore,
        modelVersion,
        alreadyOpen: candidate.alreadyOpen,
        alreadyClosed: candidate.alreadyClosed,
        eligible: candidate.eligible,
        eligibilityReason: candidate.eligibilityReason,
        now,
      },
      { env },
    )

    if (decision.action === 'skip' || decision.action === 'shadow_predict') {
      if (decision.action === 'skip') skipped += 1
      decisions.push(decision)
      continue
    }

    try {
      const exec = await adapter.open(decision)
      if (decision.action === 'live_open') liveAttempted += 1
      if (exec.opened) paperOpened += 1
      if (!exec.ok && exec.error) {
        decision.reason = exec.error
        if (decision.action === 'paper_open') skipped += 1
        else errors += 1
      } else if (exec.error === 'already_open' || exec.error === 'already_closed') {
        decision.action = 'skip'
        decision.reason = exec.error
        skipped += 1
      }
      if (exec.risk) {
        decision.risk = exec.risk
      } else if (combined != null) {
        decision.risk = riskFromScore(combined, rugTrip)
      }
    } catch (error) {
      errors += 1
      decision.reason = error instanceof Error ? error.message : String(error)
    }
    decisions.push(decision)
  }

  const predictCount = decisions.filter((d) => isPredictAction(d.action)).length
  const summary = empty({
    scanned: candidates.length,
    skipped,
    paperOpened,
    liveAttempted,
    predictCount,
    errors,
    finishedAt: new Date().toISOString(),
  })
  const persisted = await (deps.persist ?? persistEvalRun)(runId, summary, decisions)
  if (persisted && typeof persisted === 'object' && 'linkedCount' in persisted) {
    summary.linkedCount = persisted.linkedCount
  }
  return { summary, decisions }
}

export async function listEvalCandidates(opts?: {
  limit?: number
}): Promise<EvalCandidate[]> {
  const { getActiveMcapTrackerStrategies } = await import('./load-mcap-tracker')
  const { fetchMcapSimCandidateRows } = await import('@/utils/mcap-tracker')
  const { fetchTradingRecordsForWallet, loadMcapSimClosedOutcomeKeys } = await import('./db')
  const { getOpenMcapPositions, getMcapSimOpenSkipReason } = await import(
    '@/utils/mcap-sim-track'
  )
  const { simWalletForChain, MCAP_TRACKER_SIM_WALLET } = await import('./sim-wallets')

  const out: EvalCandidate[] = []
  const limit = opts?.limit ?? DEFAULT_EVAL_SCAN_LIMIT
  const poolCap = Math.max(limit * 3, 120)
  for (const chain of ['sol', 'robinhood'] as CombinedScoreChain[]) {
    const strategies = (await getActiveMcapTrackerStrategies(chain)).filter((s) =>
      isClosedLoopPrincipalId(s.id),
    )
    if (strategies.length === 0) continue
    const recency = Math.max(240, ...strategies.map((s) => s.config.query.recencyMinutes))
    const rows = await fetchMcapSimCandidateRows({
      recencyMinutes: recency,
      recentLimit: 200,
      growthLimit: 80,
      chain,
    })
    const wallet = simWalletForChain(MCAP_TRACKER_SIM_WALLET, chain as StrategyChain)
    const records = await fetchTradingRecordsForWallet(wallet)

    for (const strategy of strategies) {
      const open = new Set(
        getOpenMcapPositions(records, strategy.id, 'sim').map((p) => p.mintAddress),
      )
      const closed = await loadMcapSimClosedOutcomeKeys(
        strategy.id,
        rows.map((r) => r.token_address),
      )
      for (const snapshot of rows) {
        const skip = getMcapSimOpenSkipReason(strategy, snapshot, open, closed)
        out.push({
          mint: snapshot.token_address,
          strategyId: strategy.id,
          chain,
          alreadyOpen: skip === 'already_open',
          alreadyClosed: skip === 'already_closed',
          eligible: skip == null,
          eligibilityReason: skip,
        })
        if (out.length >= poolCap) {
          return selectDiverseEvalCandidates(out, limit)
        }
      }
    }
  }
  return selectDiverseEvalCandidates(out, limit)
}

function riskFromScore(combined: number, rugTrip: boolean): EvalRiskSnapshot {
  return {
    takeProfitPct: 200,
    stopLossPct: -50,
    holdHours: 96,
    autoSl: false,
    riskSource: rugTrip ? 'fallback_default' : 'score_overlay_v1',
  }
}

export async function persistEvalRun(
  runId: string,
  summary: EvalScanSummary,
  decisions: EvalDecision[],
): Promise<{ linkedCount: number }> {
  let linkedCount = 0
  try {
    const {
      insertEvalRun,
      insertEvalDecisions,
      insertMlPredictions,
      linkPredictionsForRun,
      rollupEvalRunAccuracy,
    } = await import('./eval-engine-db')
    const predictions = decisions
      .map((d, i) =>
        buildPredictionFromDecision(runId, d, { id: `${runId}-${i}-${d.mint.slice(0, 8)}` }),
      )
      .filter((p): p is NonNullable<typeof p> => p != null)
    await insertEvalRun(runId, { ...summary, predictCount: predictions.length })
    await insertEvalDecisions(runId, decisions)
    await insertMlPredictions(predictions)
    linkedCount = await linkPredictionsForRun(runId)
    await rollupEvalRunAccuracy(runId)
  } catch (error) {
    console.warn(
      '[eval-engine] persist failed (fail-soft):',
      error instanceof Error ? error.message : String(error),
    )
  }
  try {
    const { saveEvalLastRun } = await import('./eval-engine-db')
    saveEvalLastRun({ ...summary, linkedCount, predictCount: summary.predictCount }, decisions.length)
  } catch {
    /* ignore file persist */
  }
  return { linkedCount }
}

export async function loadEvalLastRun(): Promise<EvalScanSummary | null> {
  try {
    const { loadEvalLastRunFile, loadLatestEvalRun } = await import('./eval-engine-db')
    return (await loadLatestEvalRun()) ?? loadEvalLastRunFile()
  } catch {
    return null
  }
}
