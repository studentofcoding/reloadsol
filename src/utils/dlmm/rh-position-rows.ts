import type { RhClmmLiveRow, RhClmmPosition } from '@/types/dlmm'
import { clmmPositionKey } from '@/utils/dlmm/rh-clmm-already-empty'

export type MergedClmmOpen = {
  key: string
  liveOnly: boolean
  mark?: RhClmmPosition
  live?: RhClmmLiveRow
}

/** Open CLMM rows: DB marks plus on-chain live NFTs. Closed marks never come back. */
export function mergeClmmOpenPositions(
  openMarks: readonly RhClmmPosition[],
  liveRows: readonly RhClmmLiveRow[],
  closedKeys: ReadonlySet<string>,
): MergedClmmOpen[] {
  const byKey = new Map<string, MergedClmmOpen>()

  for (const mark of openMarks) {
    const key = clmmPositionKey(mark.protocol, mark.token_id)
    byKey.set(key, { key, liveOnly: false, mark })
  }

  for (const live of liveRows) {
    const key = clmmPositionKey(live.protocol, live.tokenId)
    if (closedKeys.has(key)) continue
    const existing = byKey.get(key)
    if (existing) {
      existing.live = live
      existing.liveOnly = false
      continue
    }
    byKey.set(key, { key, liveOnly: true, live })
  }

  return [...byKey.values()]
}

export function closedClmmKeys(
  closedMarks: readonly Pick<RhClmmPosition, 'protocol' | 'token_id'>[],
): Set<string> {
  return new Set(
    closedMarks.map((m) => clmmPositionKey(m.protocol, m.token_id)),
  )
}
