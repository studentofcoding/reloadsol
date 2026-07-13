/**
 * Offline mcap exit/entry replay for strategy search (P0).
 * Uses outcome features (monitor_snapshots + milestones) — approximate when path is sparse.
 */

import { isoWeekKey } from '@/strategies/strategy-review'
import type { StrategyOutcomeRow } from '@/strategies/types'
import { computeMcapSimPnlPct } from '@/utils/mcap-tracker'

export type McapSearchExitConfig = {
  stopLossPct: number
  takeProfitPct: number
  maxHoldHours: number
}

export type McapSearchEntryConfig = {
  mcapMin: number
  mcapMax: number
  /** If set, only include outcomes with this entry_template */
  entryTemplate?: 'first_seen' | 'milestone_80'
}

export type McapSearchConfig = {
  id: string
  exit: McapSearchExitConfig
  entry: McapSearchEntryConfig
}

export type ReplayTradeResult = {
  outcomeId: string
  strategyId: string
  pnlPct: number
  exitReason: string
  exitAt: string
  usedPath: 'snapshots' | 'milestones' | 'historical'
}

export type ConfigScore = {
  configId: string
  config: McapSearchConfig
  tradeCount: number
  winCount: number
  winRate: number
  totalPnlPct: number
  avgPnlPct: number
  maxLossStreakWeeks: number
}

type PathPoint = { at: string; mcap: number }

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function readMonitorPath(features: Record<string, unknown>): PathPoint[] {
  const raw = features.monitor_snapshots
  if (!Array.isArray(raw)) return []
  const points: PathPoint[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const at = str(o.timestamp)
    const mcap = num(o.market_cap)
    if (!at || mcap == null || mcap <= 0) continue
    points.push({ at, mcap })
  }
  return points.sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * Infer first_mcap from entry template + entry_mcap.
 * Prefer stored first_mcap (live-fill opens); /1.8 only for legacy ×1.8 fills.
 */
export function inferFirstMcap(
  entryMcap: number,
  entryTemplate: string | null,
  storedFirstMcap?: number | null,
): number {
  if (storedFirstMcap != null && storedFirstMcap > 0) return storedFirstMcap
  if (entryTemplate === 'milestone_80') return entryMcap / 1.8
  return entryMcap
}

function milestonePath(
  features: Record<string, unknown>,
  entryMcap: number,
  entryAt: string,
  exitAt: string,
  exitMcap: number,
): PathPoint[] {
  const template = str(features.entry_template)
  const first = inferFirstMcap(entryMcap, template, num(features.first_mcap))
  const points: PathPoint[] = [{ at: entryAt, mcap: entryMcap }]

  const milestones: Array<[string, number]> = [
    ['when_reach_80pct', 80],
    ['when_reach_120pct', 120],
    ['when_reach_200pct', 200],
  ]
  for (const [key, pct] of milestones) {
    const when = str(features[key])
    if (!when) continue
    if (when < entryAt || when > exitAt) continue
    points.push({ at: when, mcap: first * (1 + pct / 100) })
  }
  points.push({ at: exitAt, mcap: exitMcap })
  return points.sort((a, b) => a.at.localeCompare(b.at))
}

function closeReasonAtGrowth(
  growthPct: number,
  holdHours: number,
  exit: McapSearchExitConfig,
): string | null {
  if (growthPct >= exit.takeProfitPct) return 'take_profit'
  if (growthPct <= exit.stopLossPct) return 'stop_loss'
  if (holdHours >= exit.maxHoldHours) return 'max_age'
  return null
}

/** Replay one outcome under alternate exit rules. */
export function replayMcapOutcome(
  row: StrategyOutcomeRow,
  exit: McapSearchExitConfig,
): ReplayTradeResult | null {
  const features = (row.features ?? {}) as Record<string, unknown>
  const entryMcap = num(features.entry_mcap)
  const exitMcap = num(features.exit_mcap)
  const entryAt = row.entry_at
  const histExitAt = row.exit_at
  if (entryMcap == null || entryMcap <= 0 || !entryAt || !histExitAt) return null

  let path = readMonitorPath(features)
  let usedPath: ReplayTradeResult['usedPath'] = 'snapshots'
  if (path.length < 2 && exitMcap != null && exitMcap > 0) {
    path = milestonePath(features, entryMcap, entryAt, histExitAt, exitMcap)
    usedPath = 'milestones'
  }
  if (path.length < 2) {
    const histPnl = row.pnl_pct
    if (histPnl == null || !Number.isFinite(histPnl)) return null
    return {
      outcomeId: row.id,
      strategyId: row.strategy_id,
      pnlPct: histPnl,
      exitReason: str(features.close_reason) ?? 'historical',
      exitAt: histExitAt,
      usedPath: 'historical',
    }
  }

  const entryMs = new Date(entryAt).getTime()
  for (const pt of path) {
    if (pt.at < entryAt) continue
    const growth = computeMcapSimPnlPct(entryMcap, pt.mcap)
    const holdHours = (new Date(pt.at).getTime() - entryMs) / (1000 * 60 * 60)
    const reason = closeReasonAtGrowth(growth, holdHours, exit)
    if (reason) {
      return {
        outcomeId: row.id,
        strategyId: row.strategy_id,
        pnlPct: growth,
        exitReason: reason,
        exitAt: pt.at,
        usedPath,
      }
    }
  }

  const last = path[path.length - 1]
  return {
    outcomeId: row.id,
    strategyId: row.strategy_id,
    pnlPct: computeMcapSimPnlPct(entryMcap, last.mcap),
    exitReason: 'path_end',
    exitAt: last.at,
    usedPath,
  }
}

export function passesEntryFilter(
  row: StrategyOutcomeRow,
  entry: McapSearchEntryConfig,
): boolean {
  const features = (row.features ?? {}) as Record<string, unknown>
  const entryMcap = num(features.entry_mcap)
  if (entryMcap == null) return false
  if (entryMcap < entry.mcapMin || entryMcap > entry.mcapMax) return false
  if (entry.entryTemplate) {
    const t = str(features.entry_template)
    if (t !== entry.entryTemplate) return false
  }
  return true
}

export function scoreReplayTrades(
  config: McapSearchConfig,
  trades: ReplayTradeResult[],
): ConfigScore {
  const pnls = trades.map((t) => t.pnlPct)
  const wins = pnls.filter((p) => p >= 0).length
  const lossWeeks = new Map<string, number>()
  for (const t of trades) {
    if (t.pnlPct >= 0) continue
    const wk = isoWeekKey(t.exitAt)
    if (!wk) continue
    lossWeeks.set(wk, (lossWeeks.get(wk) ?? 0) + 1)
  }
  const weeks = Array.from(lossWeeks.keys()).sort()
  let maxStreak = 0
  let run = 0
  let prev: string | null = null
  for (const wk of weeks) {
    if (prev && weekDiff(prev, wk) === 1) run++
    else run = 1
    maxStreak = Math.max(maxStreak, run)
    prev = wk
  }

  return {
    configId: config.id,
    config,
    tradeCount: trades.length,
    winCount: wins,
    winRate: trades.length ? wins / trades.length : 0,
    totalPnlPct: pnls.reduce((a, b) => a + b, 0),
    avgPnlPct: trades.length ? pnls.reduce((a, b) => a + b, 0) / trades.length : 0,
    maxLossStreakWeeks: maxStreak,
  }
}

function weekDiff(a: string, b: string): number {
  const ma = /^(\d{4})-W(\d{2})$/.exec(a)
  const mb = /^(\d{4})-W(\d{2})$/.exec(b)
  if (!ma || !mb) return 99
  return (Number(mb[1]) - Number(ma[1])) * 52 + (Number(mb[2]) - Number(ma[2]))
}

export function replayAndScore(
  rows: StrategyOutcomeRow[],
  config: McapSearchConfig,
): ConfigScore {
  const trades: ReplayTradeResult[] = []
  for (const row of rows) {
    if (row.domain !== 'mcap_tracker') continue
    if (!passesEntryFilter(row, config.entry)) continue
    const t = replayMcapOutcome(row, config.exit)
    if (t) trades.push(t)
  }
  return scoreReplayTrades(config, trades)
}

export function buildDefaultMcapSearchGrid(): McapSearchConfig[] {
  const stopLosses = [-30, -50, -70]
  const takeProfits = [100, 150, 200, 300]
  const holds = [24, 48, 96]
  const templates: Array<'first_seen' | 'milestone_80'> = [
    'first_seen',
    'milestone_80',
  ]
  const configs: McapSearchConfig[] = []
  for (const entryTemplate of templates) {
    for (const stopLossPct of stopLosses) {
      for (const takeProfitPct of takeProfits) {
        for (const maxHoldHours of holds) {
          configs.push({
            id: `${entryTemplate}_sl${stopLossPct}_tp${takeProfitPct}_h${maxHoldHours}`,
            entry: {
              mcapMin: 30_000,
              mcapMax: 2_000_000,
              entryTemplate,
            },
            exit: { stopLossPct, takeProfitPct, maxHoldHours },
          })
        }
      }
    }
  }
  return configs
}

export type WalkForwardResult = {
  holdoutWeeks: string[]
  trainWeeks: string[]
  baselineHoldout: ConfigScore | null
  ranked: Array<ConfigScore & { train: ConfigScore; holdout: ConfigScore }>
  beatBaseline: Array<ConfigScore & { train: ConfigScore; holdout: ConfigScore }>
}

function splitByWeeks(
  rows: StrategyOutcomeRow[],
  holdoutWeekCount: number,
): { train: StrategyOutcomeRow[]; holdout: StrategyOutcomeRow[]; weeks: string[] } {
  const weekSet = new Set<string>()
  for (const row of rows) {
    const at = row.exit_at ?? row.created_at
    if (!at) continue
    const wk = isoWeekKey(at)
    if (wk) weekSet.add(wk)
  }
  const weeks = Array.from(weekSet).sort()
  const holdoutWeeks = weeks.slice(-holdoutWeekCount)
  const holdoutSet = new Set(holdoutWeeks)
  const train: StrategyOutcomeRow[] = []
  const holdout: StrategyOutcomeRow[] = []
  for (const row of rows) {
    const at = row.exit_at ?? row.created_at
    if (!at) continue
    const wk = isoWeekKey(at)
    if (!wk) continue
    if (holdoutSet.has(wk)) holdout.push(row)
    else train.push(row)
  }
  return { train, holdout, weeks }
}

export function scoreBaseline(
  rows: StrategyOutcomeRow[],
  entry: McapSearchEntryConfig,
  configId = 'baseline_historical',
): ConfigScore {
  const trades: ReplayTradeResult[] = []
  for (const row of rows) {
    if (row.domain !== 'mcap_tracker') continue
    if (!passesEntryFilter(row, entry)) continue
    if (row.pnl_pct == null || !Number.isFinite(row.pnl_pct) || !row.exit_at) continue
    trades.push({
      outcomeId: row.id,
      strategyId: row.strategy_id,
      pnlPct: row.pnl_pct,
      exitReason: 'historical',
      exitAt: row.exit_at,
      usedPath: 'historical',
    })
  }
  return scoreReplayTrades(
    {
      id: configId,
      entry,
      exit: { stopLossPct: -50, takeProfitPct: 200, maxHoldHours: 96 },
    },
    trades,
  )
}

/** Historical PnL for a live strategy id on the given rows (no replay). */
export function scoreStrategyHistorical(
  rows: StrategyOutcomeRow[],
  strategyId: string,
): ConfigScore {
  const trades: ReplayTradeResult[] = []
  for (const row of rows) {
    if (row.strategy_id !== strategyId) continue
    if (row.pnl_pct == null || !Number.isFinite(row.pnl_pct) || !row.exit_at) continue
    trades.push({
      outcomeId: row.id,
      strategyId: row.strategy_id,
      pnlPct: row.pnl_pct,
      exitReason: 'historical',
      exitAt: row.exit_at,
      usedPath: 'historical',
    })
  }
  return scoreReplayTrades(
    {
      id: strategyId,
      entry: { mcapMin: 0, mcapMax: Number.MAX_SAFE_INTEGER },
      exit: { stopLossPct: -50, takeProfitPct: 200, maxHoldHours: 96 },
    },
    trades,
  )
}

function baselineIdForConfig(config: McapSearchConfig): string {
  return config.entry.entryTemplate === 'milestone_80'
    ? 'mcap_enter_at_80'
    : 'mcap_enter_first_seen'
}

export function walkForwardSearch(params: {
  rows: StrategyOutcomeRow[]
  configs: McapSearchConfig[]
  holdoutWeeks?: number
  minTradesHoldout?: number
}): WalkForwardResult {
  const holdoutWeekCount = params.holdoutWeeks ?? 4
  const minTrades = params.minTradesHoldout ?? 5
  const { train, holdout, weeks } = splitByWeeks(params.rows, holdoutWeekCount)
  const holdoutWeeks = weeks.slice(-holdoutWeekCount)
  const trainWeeks = weeks.slice(0, Math.max(0, weeks.length - holdoutWeekCount))

  const baseFirst = scoreStrategyHistorical(holdout, 'mcap_enter_first_seen')
  const base80 = scoreStrategyHistorical(holdout, 'mcap_enter_at_80')
  const baselines = {
    mcap_enter_first_seen: baseFirst.tradeCount >= minTrades ? baseFirst : null,
    mcap_enter_at_80: base80.tradeCount >= minTrades ? base80 : null,
  }

  const ranked: WalkForwardResult['ranked'] = []
  for (const config of params.configs) {
    const trainScore = replayAndScore(train, config)
    const holdoutScore = replayAndScore(holdout, config)
    if (holdoutScore.tradeCount < minTrades) continue
    ranked.push({
      ...holdoutScore,
      train: trainScore,
      holdout: holdoutScore,
    })
  }
  ranked.sort((a, b) => b.holdout.totalPnlPct - a.holdout.totalPnlPct)

  // Combined baseline = better of the two named strategies when both exist
  const baselineCandidates = [baselines.mcap_enter_first_seen, baselines.mcap_enter_at_80].filter(
    (b): b is ConfigScore => b != null,
  )
  const baselineHoldout =
    baselineCandidates.length === 0
      ? null
      : baselineCandidates.reduce((a, b) =>
          a.totalPnlPct >= b.totalPnlPct ? a : b,
        )

  const beatBaseline = ranked.filter((r) => {
    const matched = baselines[baselineIdForConfig(r.config) as keyof typeof baselines]
    if (matched) return r.holdout.totalPnlPct > matched.totalPnlPct
    if (baselineHoldout) return r.holdout.totalPnlPct > baselineHoldout.totalPnlPct
    return true
  })

  return {
    holdoutWeeks,
    trainWeeks,
    baselineHoldout,
    ranked,
    beatBaseline,
  }
}
