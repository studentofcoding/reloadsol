/**
 * Execution adapters for the eval engine.
 * Paper → sim trading_records + phase-3 score→risk.
 * Live → stub only (no wallet / broker calls).
 */
import {
  LIVE_STUB_NO_BROKER,
  evalLiveGateError,
  type EvalDecision,
  type ExecutionAdapter,
  type ExecutionAdapterResult,
} from './eval-engine'
import { MCAP_TRACKER_SIM_WALLET, simWalletForChain } from './sim-wallets'
import type { CombinedScoreChain } from './combined-score'
import type { McapTrackerStrategy, StrategyChain } from './types'

export type PaperOpenContext = {
  chain: CombinedScoreChain
  strategy: McapTrackerStrategy
  snapshot: {
    token_address: string
    token_symbol: string
    current_mcap: number | null
    first_mcap: number | null
    first_seen_at: string
    last_updated_at: string
    when_reach_80pct: string | null
    mcap_growth_percent: number | null
    organic_score: number | null
    top_holders_pct: number | null
    volume_5m?: number | null
    label?: string | null
  }
  decision: EvalDecision
}

export type PaperExecutionDeps = {
  isOpen?: (mint: string, strategyId: string) => Promise<boolean>
  isClosed?: (mint: string, strategyId: string) => Promise<boolean>
  openPaper?: (ctx: PaperOpenContext) => Promise<ExecutionAdapterResult>
}

export class PaperExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly deps: PaperExecutionDeps = {}) {}

  async open(decision: EvalDecision): Promise<ExecutionAdapterResult> {
    if (decision.action !== 'paper_open') {
      return { ok: true, opened: false }
    }
    const isOpen = this.deps.isOpen
      ? await this.deps.isOpen(decision.mint, decision.strategyId)
      : await defaultIsOpen(decision.mint, decision.strategyId)
    if (isOpen) {
      return { ok: true, opened: false, error: 'already_open' }
    }
    const isClosed = this.deps.isClosed
      ? await this.deps.isClosed(decision.mint, decision.strategyId)
      : await defaultIsClosed(decision.mint, decision.strategyId)
    if (isClosed) {
      return { ok: true, opened: false, error: 'already_closed' }
    }
    if (this.deps.openPaper) {
      return this.deps.openPaper({
        chain: decision.strategyId.endsWith('_rh') ? 'robinhood' : 'sol',
        strategy: {
          id: decision.strategyId,
          name: decision.strategyId,
          description: '',
          is_active: true,
          execution_mode: 'sim_only',
          config: {
            entryTemplate: decision.strategyId.includes('at_80')
              ? 'milestone_80'
              : 'first_seen',
            query: { recencyMinutes: 240, limit: 300 },
            execution: { simBuySol: 0.01, maxOpenPositions: 10 },
            exit: { stopLossPct: -50, takeProfitPct: 200, maxHoldHours: 96 },
            entry: { mcapMin: 30_000, mcapMax: 2_000_000 },
          },
        },
        snapshot: {
          token_address: decision.mint,
          token_symbol: decision.mint.slice(0, 8),
          current_mcap: null,
          first_mcap: null,
          first_seen_at: decision.decidedAt,
          last_updated_at: decision.decidedAt,
          when_reach_80pct: null,
          mcap_growth_percent: null,
          organic_score: null,
          top_holders_pct: null,
        },
        decision,
      })
    }
    return defaultOpenPaper(decision)
  }

  async close(): Promise<ExecutionAdapterResult> {
    return { ok: true, opened: false }
  }
}

export class LiveExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async open(): Promise<ExecutionAdapterResult> {
    const gate = evalLiveGateError(this.env)
    if (gate) {
      console.warn(`[eval-engine] live adapter refused: ${gate}`)
      return { ok: false, error: gate, opened: false }
    }
    console.warn(`[eval-engine] live adapter stub: ${LIVE_STUB_NO_BROKER}`)
    return { ok: false, error: LIVE_STUB_NO_BROKER, opened: false }
  }

  async close(): Promise<ExecutionAdapterResult> {
    return this.open()
  }
}

export function selectExecutionAdapter(
  mode: 'paper' | 'live',
  deps?: PaperExecutionDeps,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionAdapter {
  return mode === 'live' ? new LiveExecutionAdapter(env) : new PaperExecutionAdapter(deps)
}

async function defaultIsOpen(mint: string, strategyId: string): Promise<boolean> {
  const { fetchTradingRecordsForWallet } = await import('./db')
  const { getOpenMcapPositions } = await import('@/utils/mcap-sim-track')
  const chain: StrategyChain = strategyId.endsWith('_rh') ? 'robinhood' : 'sol'
  const wallet = simWalletForChain(MCAP_TRACKER_SIM_WALLET, chain)
  const records = await fetchTradingRecordsForWallet(wallet)
  const open = getOpenMcapPositions(records, strategyId, 'sim')
  return open.some((row) => row.mintAddress === mint)
}

async function defaultIsClosed(mint: string, strategyId: string): Promise<boolean> {
  const { loadMcapSimClosedOutcomeKeys } = await import('./db')
  const keys = await loadMcapSimClosedOutcomeKeys(strategyId, [mint])
  return keys.has(mint)
}

async function buildPaperContext(decision: EvalDecision): Promise<PaperOpenContext | null> {
  const chain: CombinedScoreChain = decision.strategyId.endsWith('_rh') ? 'robinhood' : 'sol'
  const { getMergedMcapTrackerRegistry } = await import('./load-mcap-tracker')
  const { fetchMcapTrackingRow } = await import('@/utils/mcap-tracker')
  const registry = await getMergedMcapTrackerRegistry(chain)
  const strategy = registry[decision.strategyId]
  if (!strategy) return null
  const snapshot = await fetchMcapTrackingRow(decision.mint, chain)
  if (!snapshot) return null
  return { chain, strategy, snapshot, decision }
}

async function defaultOpenPaper(decision: EvalDecision): Promise<ExecutionAdapterResult> {
  const ctx = await buildPaperContext(decision)
  if (!ctx) return { ok: false, error: 'no_snapshot', opened: false }
  return openEvalPaperPosition(ctx)
}

export async function openEvalPaperPosition(
  ctx: PaperOpenContext,
): Promise<ExecutionAdapterResult> {
  const { resolveMcapSimEntry } = await import('@/utils/mcap-sim-track')
  const { resolveScoreRiskForSimOpen, stampScoreRisk } = await import(
    '@/utils/brain-score-risk'
  )
  const { buildTradingRecord, insertTradingRecord } = await import(
    '@/utils/trading-records-db'
  )
  const { getNativeUsd } = await import('@/utils/native-usd')
  const { buildMcapOutcomeFeatures } = await import('@/utils/mcap-tracker')
  const { computeEntryMcapBand } = await import('./outcome-features')

  const entry = resolveMcapSimEntry(ctx.strategy, ctx.snapshot)
  if (!entry) return { ok: false, error: 'no_entry_mcap', opened: false }

  const fallbackExit = ctx.strategy.config.exit
  const scoreRisk = await resolveScoreRiskForSimOpen({
    strategyId: ctx.strategy.id,
    mint: ctx.decision.mint,
    chain: ctx.chain,
    fallbackExit,
    score: {
      combined: ctx.decision.combined ?? 0,
      rugTrip: false,
    },
  })
  const exit = scoreRisk.applied ? scoreRisk.exit : fallbackExit
  const solAmount = ctx.strategy.config.execution.simBuySol
  const solPrice = await getNativeUsd(ctx.chain)
  const entryFeatures = stampScoreRisk(
    {
      ...buildMcapOutcomeFeatures({
        snapshot: ctx.snapshot,
        entryTemplate: ctx.strategy.config.entryTemplate,
        entryMcap: entry.entryMcap,
        exitMcap: ctx.snapshot.current_mcap ?? entry.entryMcap,
      }),
      entry_template: ctx.strategy.config.entryTemplate,
      entry_mcap: entry.entryMcap,
      entry_mcap_band: computeEntryMcapBand(entry.entryMcap),
      evalEngine: true,
      evalAction: ctx.decision.action,
      evalMode: ctx.decision.mode,
      evalReason: ctx.decision.reason,
      mlScore: ctx.decision.mlScore,
      modelVersion: ctx.decision.modelVersion,
      combined_base: ctx.decision.combined,
    },
    scoreRisk,
  )

  const wallet = simWalletForChain(MCAP_TRACKER_SIM_WALLET, ctx.chain)
  const record = buildTradingRecord({
    walletAddress: wallet,
    chain: ctx.chain,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: ctx.strategy.id,
    tokens: [
      {
        mintAddress: ctx.decision.mint,
        symbol: ctx.snapshot.token_symbol,
        tokenAmount: solAmount * 1000,
        solAmount,
        priceUsd: 0.000001,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? solAmount * solPrice : undefined,
    signatures: [`eval-paper-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      strategy_id: ctx.strategy.id,
      entry_at: entry.entryAt,
      entry_features: entryFeatures,
      effective_exit: exit,
    },
  })

  const inserted = await insertTradingRecord(record)
  if (!inserted.inserted) {
    return { ok: false, error: inserted.reason ?? 'insert_failed', opened: false }
  }
  return {
    ok: true,
    opened: true,
    risk: {
      takeProfitPct: exit.takeProfitPct,
      stopLossPct: exit.stopLossPct,
      holdHours: exit.maxHoldHours,
      autoSl: scoreRisk.autoSl,
      riskSource: scoreRisk.riskSource,
    },
  }
}
