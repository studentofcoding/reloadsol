import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import {
  getOpenMcapSimPositions,
  type McapSimOpenPosition,
} from '@/utils/mcap-sim-track'
import {
  isOpenTrackerPosition,
  isSimulatedTrackerPosition,
  resolveTrackerStrategyId,
} from '@/utils/trading-simulation'
import {
  fetchTradingRecordsForWallet,
  listStrategyOutcomes,
  loadStrategyDefinitionRows,
} from './db'
import { readTokenSymbol } from './outcome-features'
import type { StrategyDomain, StrategyOutcomeRow } from './types'

export type AlgoPosition = {
  id: string
  strategyId: string
  strategyName: string
  domain: StrategyDomain
  isSimulated: boolean
  status: 'open' | 'closed'
  outcome?: string
  tokenAddress: string | null
  tokenSymbol: string | null
  tokenName: string | null
  logoUrl: string | null
  entryPriceUsd: number | null
  exitPriceUsd: number | null
  pnlPct: number | null
  entryAt: string | null
  exitAt: string | null
}

export type AlgoPositionsResult = {
  open: AlgoPosition[]
  closed: AlgoPosition[]
}

function toFiniteOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : (value as number)
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function readFeatureNumber(
  features: Record<string, unknown> | null,
  key: string,
): number | null {
  return features ? toFiniteOrNull(features[key]) : null
}

export function mapOutcomeToAlgoPosition(
  row: StrategyOutcomeRow,
  nameById: Map<string, string>,
): AlgoPosition {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyName: nameById.get(row.strategy_id) ?? row.strategy_id,
    domain: row.domain,
    isSimulated: row.is_simulated,
    status: 'closed',
    outcome: row.status ?? undefined,
    tokenAddress: row.token_address,
    tokenSymbol: readTokenSymbol(row.features) ?? null,
    tokenName: null,
    logoUrl: null,
    entryPriceUsd: readFeatureNumber(row.features, 'initial_price_usd'),
    exitPriceUsd: readFeatureNumber(row.features, 'exit_price_usd'),
    pnlPct: row.pnl_pct,
    entryAt: row.entry_at,
    exitAt: row.exit_at,
  }
}

export type TrackerOpenRow = {
  id: string
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: unknown
  current_gain_percentage: unknown
  status: string | null
  tracking_started_at: unknown
  trading_simulation: Record<string, unknown> | null
}

export function mapTrackerRowToAlgoPosition(
  row: TrackerOpenRow,
  nameById: Map<string, string>,
): AlgoPosition | null {
  if (!isOpenTrackerPosition(row)) return null
  const strategyId = resolveTrackerStrategyId(row.trading_simulation)
  if (!strategyId) return null

  const sim = row.trading_simulation ?? {}
  const entryAt =
    typeof sim.entry_at === 'string'
      ? sim.entry_at
      : row.tracking_started_at != null
        ? String(row.tracking_started_at)
        : null

  return {
    id: `tracker:${row.id}`,
    strategyId,
    strategyName: nameById.get(strategyId) ?? strategyId,
    domain: 'trending_bot',
    isSimulated: isSimulatedTrackerPosition(row),
    status: 'open',
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    tokenName: row.token_name,
    logoUrl: row.logo_url,
    entryPriceUsd:
      toFiniteOrNull(sim.buy_price_usd) ?? toFiniteOrNull(row.initial_price_usd),
    exitPriceUsd: null,
    pnlPct: toFiniteOrNull(row.current_gain_percentage),
    entryAt,
    exitAt: null,
  }
}

export function mapMcapOpenToAlgoPosition(
  pos: McapSimOpenPosition,
  strategyId: string,
  nameById: Map<string, string>,
): AlgoPosition {
  return {
    id: `mcap:${strategyId}:${pos.mintAddress}`,
    strategyId,
    strategyName: nameById.get(strategyId) ?? strategyId,
    domain: 'mcap_tracker',
    isSimulated: true,
    status: 'open',
    tokenAddress: pos.mintAddress,
    tokenSymbol: pos.symbol || null,
    tokenName: null,
    logoUrl: null,
    entryPriceUsd: toFiniteOrNull(pos.entryFeatures.initial_price_usd),
    exitPriceUsd: null,
    pnlPct: null,
    entryAt: pos.entryAt,
    exitAt: null,
  }
}

function getTrackerTableName(): string {
  return process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'
}

/**
 * All algo strategy positions: open (trending tracker + mcap sim) and
 * closed (strategy_outcomes, newest first).
 * ponytail: signals/dlmm open positions are excluded — no shared open-position
 * helper exists; their closed trades still show via outcomes. Upgrade path:
 * add mappers per domain here.
 */
export async function getAlgoPositions(params?: {
  closedLimit?: number
}): Promise<AlgoPositionsResult> {
  const closedLimit = params?.closedLimit ?? 100

  const [defRows, outcomes, trackerRows, mcapSimRecords] = await Promise.all([
    loadStrategyDefinitionRows(),
    listStrategyOutcomes({ limit: closedLimit }),
    (async (): Promise<TrackerOpenRow[]> => {
      try {
        const { rows } = await query<TrackerOpenRow>(
          `SELECT id, token_address, token_symbol, token_name, logo_url,
                  initial_price_usd, current_gain_percentage, status,
                  tracking_started_at, trading_simulation
           FROM ${getTrackerTableName()}
           WHERE status = 'tracking'`,
        )
        return rows
      } catch (error) {
        if (isMissingSchemaError(error)) return []
        throw error
      }
    })(),
    fetchTradingRecordsForWallet(
      process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim',
    ),
  ])

  const nameById = new Map(defRows.map((d) => [d.id, d.name]))

  const open: AlgoPosition[] = []
  for (const row of trackerRows) {
    const mapped = mapTrackerRowToAlgoPosition(row, nameById)
    if (mapped) open.push(mapped)
  }
  for (const def of defRows) {
    if (def.domain !== 'mcap_tracker') continue
    for (const pos of getOpenMcapSimPositions(mcapSimRecords, def.id)) {
      open.push(mapMcapOpenToAlgoPosition(pos, def.id, nameById))
    }
  }
  open.sort((a, b) => (b.entryAt ?? '').localeCompare(a.entryAt ?? ''))

  const closed = outcomes.rows.map((row) =>
    mapOutcomeToAlgoPosition(row, nameById),
  )

  return { open, closed }
}
