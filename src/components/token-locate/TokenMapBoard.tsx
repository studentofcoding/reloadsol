'use client'

import { useCallback, useState } from 'react'
import GmgnChartEmbed from '@/components/signals/shared/GmgnChartEmbed'
import GmgnTokenStatsGrid from '@/components/token-locate/GmgnTokenStatsGrid'
import OhlcRugPanel from '@/components/token-locate/OhlcRugPanel'
import TokenMapLane from '@/components/token-locate/TokenMapLane'
import TokenMapStrategyChart from '@/components/token-locate/TokenMapStrategyChart'
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
  const [showGmgn, setShowGmgn] = useState(true)
  const [concBan, setConcBan] = useState<{
    banned: boolean
    reasons: string[]
  } | null>(null)

  const onConcentrationBan = useCallback(
    (payload: { banned: boolean; reasons: string[] }) => {
      setConcBan(payload)
    },
    [],
  )

  const concentrationBanned = concBan?.banned === true

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {result.symbol ?? 'Unknown token'}
          </h2>
          <p className="font-mono text-xs text-gray-500">{result.tokenAddress}</p>
        </div>
        {!concentrationBanned ? (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1.5 text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showGmgn}
                onChange={(e) => setShowGmgn(e.target.checked)}
                className="rounded border-gray-600 bg-gray-800"
              />
              GMGN chart
            </label>
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
        ) : null}
      </div>

      {concentrationBanned ? (
        <div className="rounded-lg border border-red-800/80 bg-red-950/50 px-3 py-2 text-sm text-red-200">
          <p className="font-semibold">Banned: concentration</p>
          {concBan?.reasons?.length ? (
            <p className="mt-1 text-xs text-red-300/90">
              {concBan.reasons.join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* OHLC rug panel always visible (evidence); GMGN only when not concentration-banned */}
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        <div className="w-full min-w-[7rem] md:w-[10%] md:shrink-0">
          <OhlcRugPanel
            tokenAddress={result.tokenAddress}
            tokenSymbol={result.symbol}
          />
        </div>
        {!concentrationBanned && showGmgn ? (
          <div className="min-w-0 h-[300px] w-full overflow-hidden rounded-xl border border-gray-700 bg-black md:w-[90%] md:flex-1">
            <GmgnChartEmbed
              tokenAddress={result.tokenAddress}
              height="100%"
              className="w-full h-full"
              title={`GMGN · ${result.symbol ?? result.tokenAddress.slice(0, 8)}`}
            />
          </div>
        ) : null}
      </div>

      <div
        className={
          concentrationBanned
            ? 'w-full max-w-xs'
            : 'flex flex-col gap-2 md:flex-row md:items-stretch'
        }
      >
        <div
          className={
            concentrationBanned
              ? 'w-full'
              : 'w-full min-w-[7rem] md:w-[10%] md:shrink-0'
          }
        >
          <GmgnTokenStatsGrid
            tokenAddress={result.tokenAddress}
            variant="rail"
            onConcentrationBan={onConcentrationBan}
          />
        </div>
        {!concentrationBanned ? (
          <div className="min-w-0 w-full md:w-[90%] md:flex-1">
            <TokenMapStrategyChart
              tokenAddress={result.tokenAddress}
              activities={activities}
              hours={24}
            />
          </div>
        ) : null}
      </div>

      {!concentrationBanned ? (
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
      ) : null}
    </div>
  )
}
