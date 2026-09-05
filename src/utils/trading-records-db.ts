import { bulkInsert, query, type BulkWriteStats } from '@/utils/db'
import { parseDbChain, normalizeRecordWallet } from '@/utils/app-network-db'
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

  const chain = parseDbChain(record.chain)
  const walletAddress = normalizeRecordWallet(record.walletAddress, chain)
  const data: TrackingRecord = { ...record, chain, walletAddress }

  const dbRecord: Omit<DatabaseRecord, 'created_at'> = {
    id: record.id,
    wallet_address: walletAddress,
    operation_type: record.operationType,
    timestamp: new Date(record.timestamp).toISOString(),
    data,
  }

  await query(
    `INSERT INTO trading_records (id, wallet_address, operation_type, timestamp, data, chain)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      dbRecord.id,
      dbRecord.wallet_address,
      dbRecord.operation_type,
      dbRecord.timestamp,
      JSON.stringify(dbRecord.data),
      chain,
    ],
  )

  await afterTradingRecordInserted(data)

  return { inserted: true }
}

const TRADING_RECORD_COLUMNS = [
  { name: 'id', type: 'text' },
  { name: 'wallet_address', type: 'text' },
  { name: 'operation_type', type: 'text' },
  { name: 'timestamp', type: 'timestamptz' },
  { name: 'data', type: 'jsonb' },
  { name: 'chain', type: 'text' },
] as const

/**
 * REL-20: bulk variant of insertTradingRecord — same validation, skip rules,
 * and per-record post-insert side effects, but one round-trip per chunk
 * (UNNEST) instead of one per record. Throws on DB error exactly like
 * insertTradingRecord so failures surface to the caller unchanged.
 */
export async function insertTradingRecords(
  records: TrackingRecord[],
): Promise<{ inserted: number; skipped: number; stats: BulkWriteStats }> {
  const accepted: { record: TrackingRecord; values: unknown[] }[] = []
  let skipped = 0

  for (const record of records) {
    if (!record.id || !record.walletAddress || !record.operationType) {
      throw new Error('Missing required fields: id, walletAddress, operationType')
    }
    if (shouldSkipTradingRecord(record)) {
      skipped++
      continue
    }
    const chain = parseDbChain(record.chain)
    const walletAddress = normalizeRecordWallet(record.walletAddress, chain)
    const data: TrackingRecord = { ...record, chain, walletAddress }
    accepted.push({
      record: data,
      values: [
        record.id,
        walletAddress,
        record.operationType,
        new Date(record.timestamp).toISOString(),
        JSON.stringify(data),
        chain,
      ],
    })
  }

  const stats = await bulkInsert({
    table: 'trading_records',
    columns: [...TRADING_RECORD_COLUMNS],
    rows: accepted.map((a) => a.values),
  })

  for (const { record } of accepted) {
    await afterTradingRecordInserted(record)
  }

  return { inserted: accepted.length, skipped, stats }
}

/** Update stored JSON for an existing trading record (server-side). */
export async function updateTradingRecordData(
  recordId: string,
  data: TrackingRecord,
): Promise<boolean> {
  try {
    const chain = parseDbChain(data.chain)
    const payload: TrackingRecord = { ...data, chain }
    const { rowCount } = await query(
      `UPDATE trading_records SET data = $2, timestamp = $3, chain = $4 WHERE id = $1`,
      [
        recordId,
        JSON.stringify(payload),
        new Date(data.timestamp).toISOString(),
        chain,
      ],
    )
    if (rowCount === 0) return false
    await afterTradingRecordInserted(payload)
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
