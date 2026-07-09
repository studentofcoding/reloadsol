import type {
  DlmmStrategy,
  ExecutionMode,
  McapTrackerStrategy,
  SignalsStrategy,
  SocialGateConfig,
  StrategyDomain,
  TrendingBotStrategy,
} from './types'
import { DEFAULT_MCAP_TRACKER_EXIT } from './registry'

export type EntryTrigger =
  | 'filter_assign'
  | 'signals_score'
  | 'first_seen'
  | 'milestone_80'
  | 'dlmm_pool_screen'

export type StrategyParameterSet = {
  domain: StrategyDomain
  strategyId: string
  executionMode: ExecutionMode
  positionSizeSol: number
  maxOpenPositions?: number
  entry: {
    trigger: EntryTrigger
    mcapMin?: number
    mcapMax?: number
    organicScoreMin?: number
    topHoldersPctMax?: number
    recencyMinutes?: number
    enterScoreFloor?: number
    minTvl?: number
    minFeeTvl?: number
    minHolders?: number
  }
  exit: {
    stopLossPct: number
    takeProfitPct: number
    takeProfitLadder?: number[]
    maxHoldHours: number
    oorTimeoutMin?: number
  }
  social?: SocialGateConfig
  extensions: Record<string, unknown>
}

export function trendingBotToCanonical(s: TrendingBotStrategy): StrategyParameterSet {
  const tp = s.take_profit_levels
  const ladder = [tp.tp1_percentage, tp.tp2_percentage]
  if (tp.tp3_enabled) ladder.push(tp.tp3_percentage)

  return {
    domain: 'trending_bot',
    strategyId: s.id,
    executionMode: s.execution_mode ?? 'sim_only',
    positionSizeSol: s.buy_amount_sol,
    entry: {
      trigger: 'filter_assign',
      mcapMin: s.filtering?.mcap?.min ?? s.conditions?.min_market_cap,
      mcapMax: s.filtering?.mcap?.max ?? s.conditions?.max_market_cap,
      organicScoreMin: s.filtering?.organicScore?.min ?? s.conditions?.min_organic_score,
      topHoldersPctMax: s.filtering?.topHoldersPercentage?.max,
    },
    exit: {
      stopLossPct: s.stop_loss_percentage,
      takeProfitPct: tp.tp1_percentage,
      takeProfitLadder: ladder,
      maxHoldHours: s.max_hold_hours,
    },
    extensions: {
      priority_fee_lamports: s.priority_fee_lamports,
      take_profit_levels: tp,
      allocation_weight: s.allocation_weight,
      filtering: s.filtering,
      conditions: s.conditions,
    },
  }
}

export function signalsToCanonical(s: SignalsStrategy): StrategyParameterSet {
  return {
    domain: 'signals',
    strategyId: s.id,
    executionMode: s.execution_mode,
    positionSizeSol: s.config.execution.simBuySol,
    maxOpenPositions: s.config.execution.maxOpenPositions,
    entry: {
      trigger: 'signals_score',
      recencyMinutes: s.config.query.recencyMinutes,
      enterScoreFloor: s.config.enterScoreFloor,
    },
    exit: {
      // Signals exits are template-driven; defaults align with mcap tracker for ML overlay later
      stopLossPct: DEFAULT_MCAP_TRACKER_EXIT.stopLossPct,
      takeProfitPct:
        s.config.template === 'sell_over_100' ? 100 : DEFAULT_MCAP_TRACKER_EXIT.takeProfitPct,
      maxHoldHours: DEFAULT_MCAP_TRACKER_EXIT.maxHoldHours,
    },
    social: s.config.social,
    extensions: {
      template: s.config.template,
      query: s.config.query,
      scoring: s.config.scoring,
    },
  }
}

export function mcapTrackerToCanonical(s: McapTrackerStrategy): StrategyParameterSet {
  return {
    domain: 'mcap_tracker',
    strategyId: s.id,
    executionMode: s.execution_mode,
    positionSizeSol: s.config.execution.simBuySol,
    maxOpenPositions: s.config.execution.maxOpenPositions,
    entry: {
      trigger: s.config.entryTemplate,
      mcapMin: s.config.entry.mcapMin,
      mcapMax: s.config.entry.mcapMax,
      organicScoreMin: s.config.entry.organicScoreMin,
      topHoldersPctMax: s.config.entry.topHoldersPctMax,
      recencyMinutes: s.config.query.recencyMinutes,
    },
    exit: {
      stopLossPct: s.config.exit.stopLossPct,
      takeProfitPct: s.config.exit.takeProfitPct,
      maxHoldHours: s.config.exit.maxHoldHours,
    },
    social: s.config.social,
    extensions: {
      entryTemplate: s.config.entryTemplate,
      query: s.config.query,
      slippageBps: s.config.execution.slippageBps,
    },
  }
}

export function dlmmToCanonical(s: DlmmStrategy): StrategyParameterSet {
  return {
    domain: 'dlmm',
    strategyId: s.id,
    executionMode: s.execution_mode,
    positionSizeSol: s.config.max_sol_per_position,
    maxOpenPositions: s.config.execution.maxOpenPositions,
    entry: {
      trigger: 'dlmm_pool_screen',
      organicScoreMin: s.config.min_organic_score,
      minTvl: s.config.min_tvl,
      minFeeTvl: s.config.min_fee_tvl,
      minHolders: s.config.min_holders,
    },
    exit: {
      stopLossPct: s.config.stop_loss_pct,
      takeProfitPct: s.config.take_profit_pct,
      maxHoldHours: 0,
      oorTimeoutMin: s.config.oor_timeout_min,
    },
    extensions: {
      max_sol_at_risk: s.config.max_sol_at_risk,
      bin_range_interval: s.config.bin_range_interval,
      simDeploySol: s.config.execution.simDeploySol,
      minCandidateScore: s.config.execution.minCandidateScore,
    },
  }
}

export async function getCanonicalParamsForStrategy(
  strategyId: string,
): Promise<StrategyParameterSet | null> {
  const { getMergedTrendingBotRegistry } = await import('./load-strategy')
  const trending = await getMergedTrendingBotRegistry()
  if (trending[strategyId]) return trendingBotToCanonical(trending[strategyId])

  const { getMergedSignalsRegistry } = await import('./load-signals')
  const signals = await getMergedSignalsRegistry()
  if (signals[strategyId]) return signalsToCanonical(signals[strategyId])

  const { getMergedMcapTrackerRegistry } = await import('./load-mcap-tracker')
  const mcap = await getMergedMcapTrackerRegistry()
  if (mcap[strategyId]) return mcapTrackerToCanonical(mcap[strategyId])

  const { getMergedDlmmStrategy } = await import('./load-dlmm')
  const dlmm = await getMergedDlmmStrategy()
  if (dlmm.id === strategyId) return dlmmToCanonical(dlmm)

  return null
}

export function mapRegistryToCanonical(params: {
  trending: Record<string, TrendingBotStrategy>
  signals: Record<string, SignalsStrategy>
  mcap: Record<string, McapTrackerStrategy>
  dlmm: DlmmStrategy
}): Record<string, StrategyParameterSet> {
  const out: Record<string, StrategyParameterSet> = {}
  for (const s of Object.values(params.trending)) {
    out[s.id] = trendingBotToCanonical(s)
  }
  for (const s of Object.values(params.signals)) {
    out[s.id] = signalsToCanonical(s)
  }
  for (const s of Object.values(params.mcap)) {
    out[s.id] = mcapTrackerToCanonical(s)
  }
  out[params.dlmm.id] = dlmmToCanonical(params.dlmm)
  return out
}
