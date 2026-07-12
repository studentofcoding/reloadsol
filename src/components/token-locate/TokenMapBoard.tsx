'use client'

import TokenMapLane from '@/components/token-locate/TokenMapLane'
import type { StrategyPresence, TokenLocateResult } from '@/strategies/token-locate'
import {
  TOKEN_MAP_LANES,
  type TokenMapActivityItem,
  type TokenMapDomain,
} from '@/strategies/token-map-types'

function groupPresence(rows: StrategyPresence[]): Map<TokenMapDomain, StrategyPresence[]> {
  const map = new Map<TokenMapDomain, StrategyPresence[]>()
  for (const lane of TOKEN_MAP_LANES) map.set(lane.domain, [])

  const laneIds = new Set(TOKEN_MAP_LANES.map((l) => l.domain))
  for (const row of rows) {
    const domain = laneIds.has(row.domain as TokenMapDomain)
      ? (row.domain as TokenMapDomain)
      : null
    if (!domain) continue
    map.get(domain)!.push(row)
  }
  return map
}

function groupActivity(
  items: TokenMapActivityItem[],
): Map<TokenMapDomain, TokenMapActivityItem[]> {
  const map = new Map<TokenMapDomain, TokenMapActivityItem[]>()
  for (const lane of TOKEN_MAP_LANES) map.set(lane.domain, [])
  for (const item of items) {
    if (!map.has(item.domain)) continue
    map.get(item.domain)!.push(item)
  }
  return map
}

export default function TokenMapBoard({
  result,
  activities,
  newIds,
}: {
  result: TokenLocateResult
  activities: TokenMapActivityItem[]
  newIds: Set<string>
}) {
  const presenceByDomain = groupPresence(result.strategyPresence ?? [])
  const activityByDomain = groupActivity(activities)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {result.symbol ?? 'Unknown token'}
          </h2>
          <p className="font-mono text-xs text-gray-500">{result.tokenAddress}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <a href={result.links.chart} className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">
            Chart
          </a>
          <a href={result.links.jupiter} className="text-blue-400 hover:underline" target="_blank" rel="noreferrer">
            Jupiter
          </a>
          <a href={result.links.strategies} className="text-blue-400 hover:underline">
            Outcomes
          </a>
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {TOKEN_MAP_LANES.map((lane) => (
          <TokenMapLane
            key={lane.domain}
            domain={lane.domain}
            label={lane.label}
            presence={presenceByDomain.get(lane.domain) ?? []}
            activities={activityByDomain.get(lane.domain) ?? []}
            newIds={newIds}
          />
        ))}
      </div>
    </div>
  )
}
