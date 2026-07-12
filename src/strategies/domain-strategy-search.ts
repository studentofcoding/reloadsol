/**
 * P3: Offline param search for gmgn + signals (same walk-forward shape as mcap P0).
 * Uses historical outcome PnL with entry-feature filters (sparse path → no exit replay).
 */

import { isoWeekKey } from '@/strategies/strategy-review'
import type { StrategyDomain, StrategyOutcomeRow } from '@/strategies/types'
import {
  type ConfigScore,
  type McapSearchConfig,
  buildDefaultMcapSearchGrid,
  scoreStrategyHistorical,
  walkForwardSearch,
} from '@/strategies/mcap-exit-replay'

export type DomainSearchConfig = {
  id: string
  domain: StrategyDomain
  /** Opaque knobs for candidate JSON / bandit spawn */
  params: Record<string, unknown>
}

export type DomainConfigScore = ConfigScore & {
  domain: StrategyDomain
  params: Record<string, unknown>
}

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

function weekDiff(a: string, b: string): number {
  const ma = /^(\d{4})-W(\d{2})$/.exec(a)
  const mb = /^(\d{4})-W(\d{2})$/.exec(b)
  if (!ma || !mb) return 99
  return (Number(mb[1]) - Number(ma[1])) * 52 + (Number(mb[2]) - Number(ma[2]))
}

function scoreHistoricalFiltered(
  config: DomainSearchConfig,
  rows: StrategyOutcomeRow[],
  passes: (row: StrategyOutcomeRow) => boolean,
): DomainConfigScore {
  const trades: Array<{ pnlPct: number; exitAt: string }> = []
  for (const row of rows) {
    if (row.domain !== config.domain) continue
    if (!passes(row)) continue
    if (row.pnl_pct == null || !Number.isFinite(row.pnl_pct) || !row.exit_at) continue
    trades.push({ pnlPct: row.pnl_pct, exitAt: row.exit_at })
  }
  const wins = trades.filter((t) => t.pnlPct >= 0).length
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
  const totalPnlPct = trades.reduce((a, t) => a + t.pnlPct, 0)
  return {
    configId: config.id,
    config: {
      id: config.id,
      entry: { mcapMin: 0, mcapMax: Number.MAX_SAFE_INTEGER },
      exit: { stopLossPct: -50, takeProfitPct: 200, maxHoldHours: 96 },
    },
    domain: config.domain,
    params: config.params,
    tradeCount: trades.length,
    winCount: wins,
    winRate: trades.length ? wins / trades.length : 0,
    totalPnlPct,
    avgPnlPct: trades.length ? totalPnlPct / trades.length : 0,
    maxLossStreakWeeks: maxStreak,
  }
}

/** GMGN: filter by security / radar-ish features stored on outcomes. */
export function passesGmgnEntryFilter(
  row: StrategyOutcomeRow,
  params: {
    minSmartWallets?: number
    maxTop10HolderRate?: number
    minRadarScore?: number
    source?: string
  },
): boolean {
  const f = (row.features ?? {}) as Record<string, unknown>
  if (params.source) {
    const src = str(f.discovery_source) ?? str(f.source)
    if (src && src !== params.source) return false
  }
  if (params.minSmartWallets != null) {
    const n =
      num(f.smart_wallets) ??
      num(f.min_smart_wallets) ??
      num(f.smart_money_count)
    if (n != null && n < params.minSmartWallets) return false
  }
  if (params.maxTop10HolderRate != null) {
    const r = num(f.top_10_holder_rate) ?? num(f.top10_holder_rate)
    if (r != null && r > params.maxTop10HolderRate) return false
  }
  if (params.minRadarScore != null) {
    const s = num(f.radar_score) ?? num(f.gmgn_radar_score) ?? num(f.score)
    if (s != null && s < params.minRadarScore) return false
  }
  return true
}

/** Signals: filter by enter score / growth features. */
export function passesSignalsEntryFilter(
  row: StrategyOutcomeRow,
  params: {
    enterScoreFloor?: number
    minGrowth?: number
    template?: string
  },
): boolean {
  const f = (row.features ?? {}) as Record<string, unknown>
  if (params.template) {
    const t = str(f.template) ?? str(f.entry_template)
    if (t && t !== params.template) return false
  }
  if (params.enterScoreFloor != null) {
    const score = num(f.enter_score) ?? num(f.score) ?? num(f.signal_score)
    if (score != null && score < params.enterScoreFloor) return false
  }
  if (params.minGrowth != null) {
    const g = num(f.growth_pct) ?? num(f.min_growth) ?? num(f.entry_growth)
    if (g != null && g < params.minGrowth) return false
  }
  return true
}

export function buildDefaultGmgnSearchGrid(): DomainSearchConfig[] {
  const configs: DomainSearchConfig[] = []
  for (const minSmartWallets of [2, 3, 5]) {
    for (const maxTop10HolderRate of [0.15, 0.2, 0.3]) {
      for (const minRadarScore of [0, 40, 60]) {
        for (const stopLossPct of [-15, -25, -40]) {
          for (const takeProfitPct of [30, 50, 100]) {
            configs.push({
              id: `gmgn_sm${minSmartWallets}_t10${maxTop10HolderRate}_r${minRadarScore}_sl${stopLossPct}_tp${takeProfitPct}`,
              domain: 'gmgn',
              params: {
                security: { minSmartWallets, maxTop10HolderRate },
                minRadarScore,
                exit: { stopLossPct, takeProfitPct, maxHoldHours: 12 },
                discovery: { source: 'smartmoney' },
              },
            })
          }
        }
      }
    }
  }
  return configs
}

export function buildDefaultSignalsSearchGrid(): DomainSearchConfig[] {
  const configs: DomainSearchConfig[] = []
  for (const enterScoreFloor of [40, 50, 60, 70]) {
    for (const minGrowth of [0, 10, 25]) {
      for (const template of ['default', 'sell_over_100'] as const) {
        configs.push({
          id: `signals_score${enterScoreFloor}_g${minGrowth}_${template}`,
          domain: 'signals',
          params: {
            enterScoreFloor,
            template,
            query: { minGrowth },
          },
        })
      }
    }
  }
  return configs
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

export type DomainWalkForwardResult = {
  domain: StrategyDomain
  holdoutWeeks: string[]
  trainWeeks: string[]
  baselineHoldout: DomainConfigScore | null
  ranked: Array<DomainConfigScore & { train: DomainConfigScore; holdout: DomainConfigScore }>
  beatBaseline: Array<DomainConfigScore & { train: DomainConfigScore; holdout: DomainConfigScore }>
}

export function walkForwardDomainSearch(params: {
  domain: StrategyDomain
  rows: StrategyOutcomeRow[]
  configs: DomainSearchConfig[]
  holdoutWeeks?: number
  minTradesHoldout?: number
  baselineStrategyId?: string
}): DomainWalkForwardResult {
  const holdoutWeekCount = params.holdoutWeeks ?? 4
  const minTrades = params.minTradesHoldout ?? 5
  const { train, holdout, weeks } = splitByWeeks(params.rows, holdoutWeekCount)
  const holdoutWeeks = weeks.slice(-holdoutWeekCount)
  const trainWeeks = weeks.slice(0, Math.max(0, weeks.length - holdoutWeekCount))

  const filterFor = (config: DomainSearchConfig) => {
    if (config.domain === 'gmgn') {
      const p = config.params as {
        security?: { minSmartWallets?: number; maxTop10HolderRate?: number }
        minRadarScore?: number
        discovery?: { source?: string }
      }
      return (row: StrategyOutcomeRow) =>
        passesGmgnEntryFilter(row, {
          minSmartWallets: p.security?.minSmartWallets,
          maxTop10HolderRate: p.security?.maxTop10HolderRate,
          minRadarScore: p.minRadarScore,
          source: p.discovery?.source,
        })
    }
    const p = config.params as {
      enterScoreFloor?: number
      template?: string
      query?: { minGrowth?: number }
    }
    return (row: StrategyOutcomeRow) =>
      passesSignalsEntryFilter(row, {
        enterScoreFloor: p.enterScoreFloor,
        template: p.template,
        minGrowth: p.query?.minGrowth,
      })
  }

  const ranked: DomainWalkForwardResult['ranked'] = []
  for (const config of params.configs) {
    const passes = filterFor(config)
    const trainScore = scoreHistoricalFiltered(config, train, passes)
    const holdoutScore = scoreHistoricalFiltered(config, holdout, passes)
    if (holdoutScore.tradeCount < minTrades) continue
    ranked.push({ ...holdoutScore, train: trainScore, holdout: holdoutScore })
  }
  ranked.sort((a, b) => b.holdout.totalPnlPct - a.holdout.totalPnlPct)

  const baselineId =
    params.baselineStrategyId ??
    (params.domain === 'gmgn'
      ? 'gmgn_smartmoney_default'
      : 'signals_default')
  const hist = scoreStrategyHistorical(holdout, baselineId)
  const baselineHoldout: DomainConfigScore | null =
    hist.tradeCount >= minTrades
      ? { ...hist, domain: params.domain, params: {} }
      : null

  const beatBaseline = baselineHoldout
    ? ranked.filter((r) => r.holdout.totalPnlPct > baselineHoldout.totalPnlPct)
    : ranked

  return {
    domain: params.domain,
    holdoutWeeks,
    trainWeeks,
    baselineHoldout,
    ranked,
    beatBaseline,
  }
}

/** Dispatch mcap → P0 engine; gmgn/signals → P3 filter search. */
export function runDomainSearch(params: {
  domain: StrategyDomain
  rows: StrategyOutcomeRow[]
  holdoutWeeks?: number
  minTradesHoldout?: number
}): {
  domain: StrategyDomain
  holdoutWeeks: string[]
  trainWeeks: string[]
  baselineHoldout: ConfigScore | DomainConfigScore | null
  ranked: Array<{
    configId: string
    holdout: ConfigScore | DomainConfigScore
    train: ConfigScore | DomainConfigScore
    config: McapSearchConfig | (DomainSearchConfig & Record<string, unknown>)
    beatsBaseline: boolean
  }>
  beatBaseline: Array<{
    configId: string
    holdout: ConfigScore | DomainConfigScore
    train: ConfigScore | DomainConfigScore
    config: McapSearchConfig | (DomainSearchConfig & Record<string, unknown>)
  }>
} {
  if (params.domain === 'mcap_tracker') {
    const configs = buildDefaultMcapSearchGrid()
    const result = walkForwardSearch({
      rows: params.rows,
      configs,
      holdoutWeeks: params.holdoutWeeks,
      minTradesHoldout: params.minTradesHoldout,
    })
    const mapRow = (r: (typeof result.ranked)[0], beats: boolean) => ({
      configId: r.configId,
      holdout: r.holdout,
      train: r.train,
      config: r.config,
      beatsBaseline: beats,
    })
    return {
      domain: 'mcap_tracker',
      holdoutWeeks: result.holdoutWeeks,
      trainWeeks: result.trainWeeks,
      baselineHoldout: result.baselineHoldout,
      ranked: result.ranked.map((r) =>
        mapRow(r, result.beatBaseline.some((b) => b.configId === r.configId)),
      ),
      beatBaseline: result.beatBaseline.map((r) => mapRow(r, true)),
    }
  }

  const configs =
    params.domain === 'gmgn'
      ? buildDefaultGmgnSearchGrid()
      : buildDefaultSignalsSearchGrid()
  const result = walkForwardDomainSearch({
    domain: params.domain,
    rows: params.rows,
    configs,
    holdoutWeeks: params.holdoutWeeks,
    minTradesHoldout: params.minTradesHoldout,
  })
  const mapRow = (r: (typeof result.ranked)[0], beats: boolean) => ({
    configId: r.configId,
    holdout: r.holdout,
    train: r.train,
    config: {
      id: r.configId,
      domain: r.domain,
      params: r.params,
      ...r.params,
    },
    beatsBaseline: beats,
  })
  return {
    domain: params.domain,
    holdoutWeeks: result.holdoutWeeks,
    trainWeeks: result.trainWeeks,
    baselineHoldout: result.baselineHoldout,
    ranked: result.ranked.map((r) =>
      mapRow(r, result.beatBaseline.some((b) => b.configId === r.configId)),
    ),
    beatBaseline: result.beatBaseline.map((r) => mapRow(r, true)),
  }
}