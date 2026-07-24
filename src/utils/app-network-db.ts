import type { AppNetwork } from '@/utils/app-network'
import { parseAppNetwork } from '@/utils/app-network'

/** Parse chain query/body for DB filters. Defaults to sol. */
export function parseDbChain(raw: string | null | undefined): AppNetwork {
  return parseAppNetwork(raw)
}

/** Keep only records whose chain matches (missing chain treated as sol). */
export function filterRecordsByChain<T extends { chain?: string | null }>(
  records: T[],
  chain: AppNetwork,
): T[] {
  return records.filter((r) => parseDbChain(r.chain) === chain)
}
