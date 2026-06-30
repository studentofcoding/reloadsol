import { query } from '@/utils/db'
import type { TrackingRecord } from '@/utils/trading-tracker'
import { invalidateTradingRecordsCache } from '@/utils/trading-records-cache'
import { broadcastTradeUpdateServer } from '@/utils/trading-notifications'

interface DatabaseRecord {
  id: string
  wallet_address: string
  operation_type: string
  timestamp: string
  data: TrackingRecord
}

export function shouldSkipTradingRecord(record: TrackingRecord): boolean {
  return (
    (record.errors != null && record.errors.length > 0) ||
    (record.failureCount > 0 && record.successCount === 0)
  )
}

/** Insert a trading record directly into Postgres (server-side). */
export async function insertTradingRecord(
  record: TrackingRecord,
): Promise<{ inserted: boolean; skipped?: boolean; reason?: string }> {
  if (!record.id || !record.walletAddress || !record.operationType) {
    throw new Error('Missing required fields: id, walletAddress, operationType')
  }

  if (shouldSkipTradingRecord(record)) {
    return {
      inserted: false,
      skipped: true,
      reason: 'Record contains errors or represents failed operation',
    }
  }

  const dbRecord: Omit<DatabaseRecord, 'created_at'> = {
    id: record.id,
    wallet_address: record.walletAddress,
    operation_type: record.operationType,
    timestamp: new Date(record.timestamp).toISOString(),
    data: record,
  }

  await query(
    `INSERT INTO trading_records (id, wallet_address, operation_type, timestamp, data)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      dbRecord.id,
      dbRecord.wallet_address,
      dbRecord.operation_type,
      dbRecord.timestamp,
      JSON.stringify(dbRecord.data),
    ],
  )

  await afterTradingRecordInserted(record)

  return { inserted: true }
}

/** Update stored JSON for an existing trading record (server-side). */
export async function updateTradingRecordData(
  recordId: string,
  data: TrackingRecord,
): Promise<boolean> {
  try {
    const { rowCount } = await query(
      `UPDATE trading_records SET data = $2, timestamp = $3 WHERE id = $1`,
      [recordId, JSON.stringify(data), new Date(data.timestamp).toISOString()],
    )
    if (rowCount === 0) return false
    await afterTradingRecordInserted(data)
    return true
  } catch (error) {
    console.warn('[trading-records-db] update failed:', (error as Error).message)
    return false
  }
}

/** Invalidate GET cache and broadcast SSE after any successful insert. */
export async function afterTradingRecordInserted(
  record: TrackingRecord,
): Promise<void> {
  const invalidated = invalidateTradingRecordsCache(record.walletAddress)
  if (invalidated > 0) {
    console.log(
      `🗑️ Invalidated ${invalidated} cache entries for wallet ${record.walletAddress.substring(0, 8)}...`,
    )
  }

  try {
    await broadcastTradeUpdateServer(record.walletAddress, record.operationType)
  } catch (broadcastError) {
    console.warn('Failed to broadcast trade update:', broadcastError)
  }
}

/** Build a complete record with id/timestamp for server inserts. */
export function buildTradingRecord(
  record: Omit<TrackingRecord, 'id' | 'timestamp'>,
): TrackingRecord {
  return {
    ...record,
    id: `${record.walletAddress}-${record.operationType}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
  }
}
