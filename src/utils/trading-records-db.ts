import { supabase } from '@/utils/supabase'
import type { TrackingRecord } from '@/utils/trading-tracker'

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

/** Insert a trading record directly into Supabase (server-side). */
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

  const { error } = await supabase.from('trading_records').insert(dbRecord)

  if (error) {
    throw error
  }

  return { inserted: true }
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
