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
import { getPositions } from '@/utils/dlmm/db'
import type { DlmmPosition } from '@/types/dlmm'
import {
  fetchTradingRecordsForWallet,
  listStrategyOutcomes,
  loadStrategyDefinitionRows,
} from './db'
import { readTokenSymbol } from './outcome-features'
import { getOpenStrategySimPositions } from './open-strategy-sim-positions'
import {
  GMGN_SIM_WALLET,
  MCAP_TRACKER_SIM_WALLET,
  SIGNALS_SIM_WALLET,
  SOCIAL_SIM_WALLET,
  TRENDING_BOT_SIM_WALLET,
  simWalletForChain,
} from './sim-wallets'
import type { StrategyChain, StrategyDomain, StrategyOutcomeRow } from './types'

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
  /** mcap_tracker sims use entry/exit mcap, not token price */
  entryMcap: number | null
  exitMcap: number | null
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
    entryMcap: readFeatureNumber(row.features, 'entry_mcap'),
    exitMcap: readFeatureNumber(row.features, 'exit_mcap'),
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
    entryMcap: null,
    exitMcap: null,
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
    entryMcap: pos.entryMcap > 0 ? pos.entryMcap : null,
    exitMcap: null,
    pnlPct: null,
    entryAt: pos.entryAt,
    exitAt: null,
  }
}

export function mapWalletOpenToAlgoPosition(
  pos: {
    mintAddress: string
    symbol: string
    entryAt: string | null
    entryPriceUsd: number
  },
  strategyId: string,
  domain: 'signals' | 'gmgn' | 'social' | 'trending_bot',
  nameById: Map<string, string>,
): AlgoPosition {
  return {
    id: `${domain}:${strategyId}:${pos.mintAddress}`,
    strategyId,
    strategyName: nameById.get(strategyId) ?? strategyId,
    domain,
    isSimulated: true,
    status: 'open',
    tokenAddress: pos.mintAddress,
    tokenSymbol: pos.symbol || null,
    tokenName: null,
    logoUrl: null,
    entryPriceUsd:
      pos.entryPriceUsd > 0 ? pos.entryPriceUsd : null,
    exitPriceUsd: null,
    entryMcap: null,
    exitMcap: null,
    pnlPct: null,
    entryAt: pos.entryAt,
    exitAt: null,
  }
}

export function mapDlmmPositionToAlgoPosition(
  p: DlmmPosition,
  nameById: Map<string, string>,
): AlgoPosition | null {
  if (!['open', 'out_of_range', 'pending'].includes(p.status)) return null
  return {
    id: `dlmm:${p.id}`,
    strategyId: 'dlmm_default',
    strategyName: nameById.get('dlmm_default') ?? 'dlmm_default',
    domain: 'dlmm',
    isSimulated: true,
    status: 'open',
    tokenAddress: null,
    tokenSymbol: p.pool_name || p.token_x_symbol || p.token_y_symbol || null,
    tokenName: null,
    logoUrl: null,
    entryPriceUsd: p.entry_value_usd > 0 ? p.entry_value_usd : null,
    exitPriceUsd: null,
    entryMcap: null,
    exitMcap: null,
    pnlPct: p.pnl_pct,
    entryAt: p.created_at,
    exitAt: null,
  }
}

function getTrackerTableName(): string {
  return process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'
}

/**
 * All algo strategy positions: open (all domains) and closed (strategy_outcomes).
 */
export async function getAlgoPositions(params?: {
  closedLimit?: number
  chain?: StrategyChain
}): Promise<AlgoPositionsResult> {
  const closedLimit = params?.closedLimit ?? 100
  const chain = params?.chain ?? 'sol'
  const isSol = chain === 'sol'

  const [
    defRows,
    outcomes,
    trackerRows,
    mcapSimRecords,
    signalsRecords,
    gmgnRecords,
    socialRecords,
    trendingRecords,
    dlmmPositions,
  ] = await Promise.all([
    loadStrategyDefinitionRows(undefined, chain),
    listStrategyOutcomes({ limit: closedLimit, chain }),
    (async (): Promise<TrackerOpenRow[]> => {
      // The Solana tracker table has no RH twin; RH trending sims live in trading_records.
      if (!isSol) return []
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
    fetchTradingRecordsForWallet(simWalletForChain(MCAP_TRACKER_SIM_WALLET, chain)),
    fetchTradingRecordsForWallet(simWalletForChain(SIGNALS_SIM_WALLET, chain)),
    fetchTradingRecordsForWallet(simWalletForChain(GMGN_SIM_WALLET, chain)),
    isSol ? fetchTradingRecordsForWallet(SOCIAL_SIM_WALLET) : [],
    isSol
      ? []
      : fetchTradingRecordsForWallet(
          simWalletForChain(TRENDING_BOT_SIM_WALLET, chain),
        ),
    isSol ? getPositions() : [],
  ])

  const nameById = new Map(defRows.map((d) => [d.id, d.name]))

  const open: AlgoPosition[] = []
  for (const row of trackerRows) {
    const mapped = mapTrackerRowToAlgoPosition(row, nameById)
    if (mapped) open.push(mapped)
  }
  for (const def of defRows) {
    if (def.domain === 'mcap_tracker') {
      for (const pos of getOpenMcapSimPositions(mcapSimRecords, def.id)) {
        open.push(mapMcapOpenToAlgoPosition(pos, def.id, nameById))
      }
    } else if (def.domain === 'signals') {
      for (const pos of getOpenStrategySimPositions(signalsRecords, def.id)) {
        open.push(mapWalletOpenToAlgoPosition(pos, def.id, 'signals', nameById))
      }
    } else if (def.domain === 'gmgn') {
      for (const pos of getOpenStrategySimPositions(gmgnRecords, def.id)) {
        open.push(mapWalletOpenToAlgoPosition(pos, def.id, 'gmgn', nameById))
      }
    } else if (def.domain === 'social') {
      for (const pos of getOpenStrategySimPositions(socialRecords, def.id)) {
        open.push(mapWalletOpenToAlgoPosition(pos, def.id, 'social', nameById))
      }
    } else if (def.domain === 'trending_bot' && !isSol) {
      for (const pos of getOpenStrategySimPositions(trendingRecords, def.id)) {
        open.push(
          mapWalletOpenToAlgoPosition(pos, def.id, 'trending_bot', nameById),
        )
      }
    }
  }
  for (const p of dlmmPositions) {
    const mapped = mapDlmmPositionToAlgoPosition(p, nameById)
    if (mapped) open.push(mapped)
  }
  open.sort((a, b) => (b.entryAt ?? '').localeCompare(a.entryAt ?? ''))

  const closed = outcomes.rows.map((row) =>
    mapOutcomeToAlgoPosition(row, nameById),
  )

  return { open, closed }
}
