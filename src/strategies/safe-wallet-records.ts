import { fetchTradingRecordsForWallet } from '@/strategies/db'
import type { TrackingRecord } from '@/utils/trading-tracker'
import { log } from '@/utils/unified-logger'

/**
 * `fetchTradingRecordsForWallet` THROWS on a DB error (it used to return `[]`, which every caller
 * read as "no records": the closer retired mirrors as already-closed and the open gate saw zero open
 * positions and opened duplicates). A cron loop must not die on one unreadable wallet, so loops use
 * this: it logs at error level with the caller's context and returns `null`. The caller MUST treat
 * `null` as "skip this unit of work", never as an empty ledger.
 */
export async function tryFetchWalletRecords(
  walletAddress: string,
  context: Record<string, unknown>,
  opts?: Parameters<typeof fetchTradingRecordsForWallet>[1],
): Promise<TrackingRecord[] | null> {
  try {
    return await fetchTradingRecordsForWallet(walletAddress, opts)
  } catch (error) {
    log.error(
      'error_handling',
      'Wallet ledger read failed — skipping this unit of work (NOT treating it as an empty ledger)',
      error as Error,
      { walletAddress, ...context },
    )
    return null
  }
}
