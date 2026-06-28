import { supabase } from '@/utils/supabase'
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

export async function fetchTrackerTokenMetrics(
  tokenAddress: string,
): Promise<TrackerTokenMetrics | null> {
  const { data, error } = await supabase
    .from(TRACKER_TABLE)
    .select('volume_5m, last_price_usd, price_history')
    .eq('token_address', tokenAddress)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  return {
    volume_5m:
      typeof data.volume_5m === 'number' && Number.isFinite(data.volume_5m)
        ? data.volume_5m
        : null,
    last_price_usd:
      typeof data.last_price_usd === 'number' && Number.isFinite(data.last_price_usd)
        ? data.last_price_usd
        : null,
    price_history: data.price_history,
  }
}

export async function resolveTokenMonitorSnapshot(
  tokenAddress: string,
  marketCap?: number | null,
): Promise<MonitorSnapshot> {
  const metrics = await fetchTrackerTokenMetrics(tokenAddress)
  const history = parsePriceHistory(metrics?.price_history)
  const lastHistory = history.length > 0 ? history[history.length - 1] : null

  return {
    timestamp: new Date().toISOString(),
    price_usd: metrics?.last_price_usd ?? lastHistory?.price_usd ?? null,
    volume_5m:
      metrics?.volume_5m ??
      lastHistory?.volume_5m ??
      null,
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
