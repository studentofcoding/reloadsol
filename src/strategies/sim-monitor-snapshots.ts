import { queryOne } from '@/utils/db'
import { fetchJupiterMarketHints } from '@/utils/jupiter-metadata'
import type { TrackingRecord } from '@/utils/trading-tracker'
import {
  appendMonitorSnapshot,
  readMonitorSnapshotsFromFeatures,
  type MonitorSnapshot,
} from './entry-feature-snapshot'
import { parsePriceHistory } from './trade-window-chart-data'

const TRACKER_TABLE =
  process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'

export type TrackerTokenMetrics = {
  volume_5m: number | null
  last_price_usd: number | null
  price_history: unknown
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function fetchTrackerTokenMetrics(
  tokenAddress: string,
): Promise<TrackerTokenMetrics | null> {
  try {
    const data = await queryOne<{
      volume_5m: unknown
      last_price_usd: unknown
      price_history: unknown
    }>(
      `SELECT volume_5m, last_price_usd, price_history
       FROM ${TRACKER_TABLE}
       WHERE token_address = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [tokenAddress],
    )

    if (!data) return null

    return {
      volume_5m: finiteOrNull(data.volume_5m),
      last_price_usd: finiteOrNull(data.last_price_usd),
      price_history: data.price_history,
    }
  } catch {
    return null
  }
}

async function fetchMcapVolume5m(tokenAddress: string): Promise<number | null> {
  try {
    const data = await queryOne<{ volume_5m: unknown }>(
      `SELECT volume_5m FROM token_mcap_tracking WHERE token_address = $1 LIMIT 1`,
      [tokenAddress],
    )
    return finiteOrNull(data?.volume_5m)
  } catch {
    return null
  }
}

/**
 * Monitor tick waterfall: trending tracker → mcap volume_5m → Jupiter v2
 * (usdPrice + stats5m buy+sell). Jupiter is only called when price or volume
 * is still missing after local sources.
 */
export async function resolveTokenMonitorSnapshot(
  tokenAddress: string,
  marketCap?: number | null,
): Promise<MonitorSnapshot> {
  const metrics = await fetchTrackerTokenMetrics(tokenAddress)
  const history = parsePriceHistory(metrics?.price_history)
  const lastHistory = history.length > 0 ? history[history.length - 1] : null

  let price_usd =
    metrics?.last_price_usd ?? lastHistory?.price_usd ?? null
  let volume_5m = metrics?.volume_5m ?? lastHistory?.volume_5m ?? null

  if (volume_5m == null) {
    volume_5m = await fetchMcapVolume5m(tokenAddress)
  }

  if (price_usd == null || volume_5m == null) {
    const jupiter = await fetchJupiterMarketHints(tokenAddress)
    if (jupiter) {
      if (price_usd == null) price_usd = jupiter.usdPrice
      if (volume_5m == null) volume_5m = jupiter.volume5m
    }
  }

  return {
    timestamp: new Date().toISOString(),
    price_usd,
    volume_5m,
    market_cap: marketCap ?? null,
  }
}

export function findStrategyBuyRecord(
  records: TrackingRecord[],
  strategyId: string,
  mintAddress: string,
): TrackingRecord | undefined {
  return [...records]
    .reverse()
    .find(
      (rec) =>
        rec.operationType === 'buy' &&
        rec.bot_strategy === strategyId &&
        rec.tokens?.some((t) => t.mintAddress === mintAddress),
    )
}

export async function persistBuyRecordMonitorSnapshot(params: {
  buyRecord: TrackingRecord
  snapshot: MonitorSnapshot
}): Promise<TrackingRecord | null> {
  const { updateTradingRecordData } = await import('@/utils/trading-records-db')
  const sim = (params.buyRecord.trading_simulation ?? {}) as Record<string, unknown>
  const entryFeatures =
    sim.entry_features && typeof sim.entry_features === 'object'
      ? (sim.entry_features as Record<string, unknown>)
      : {}
  const monitors = appendMonitorSnapshot(
    readMonitorSnapshotsFromFeatures(entryFeatures),
    params.snapshot,
  )
  const nextSim = {
    ...sim,
    entry_features: {
      ...entryFeatures,
      monitor_snapshots: monitors,
    },
  }
  const nextRecord: TrackingRecord = {
    ...params.buyRecord,
    trading_simulation: nextSim,
  }
  const ok = await updateTradingRecordData(params.buyRecord.id, nextRecord)
  return ok ? nextRecord : null
}

export async function appendSimPositionMonitorSnapshot(params: {
  records: TrackingRecord[]
  strategyId: string
  mintAddress: string
  marketCap?: number | null
}): Promise<void> {
  const buyRecord = findStrategyBuyRecord(
    params.records,
    params.strategyId,
    params.mintAddress,
  )
  if (!buyRecord) return

  const snapshot = await resolveTokenMonitorSnapshot(
    params.mintAddress,
    params.marketCap ?? null,
  )
  await persistBuyRecordMonitorSnapshot({ buyRecord, snapshot })
}

export { TRACKER_TABLE }
