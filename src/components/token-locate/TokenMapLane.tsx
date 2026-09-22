'use client'

import TokenMapActivityRow from '@/components/token-locate/TokenMapActivityRow'
import type { StrategyPresence } from '@/strategies/token-locate'
import type { TokenMapActivityItem, TokenMapDomain } from '@/strategies/token-map-types'
import {
  strategyPresenceTitle,
  trackerLabelDisplay,
} from '@/utils/tracker-label'

export default function TokenMapLane({
  domain,
  label,
  presence,
  activities,
  newIds,
}: {
  domain: TokenMapDomain
  label: string
  presence: StrategyPresence[]
  activities: TokenMapActivityItem[]
  newIds: Set<string>
}) {
  const present = presence.length > 0
  const primary = presence[0]
  const headerChip = present
    ? trackerLabelDisplay(primary?.label) ??
      primary?.label ??
      primary?.status ??
      'present'
    : 'absent'

  return (
    <section className="flex w-72 shrink-0 flex-col rounded-lg border border-gray-700 bg-gray-950/60">
      <header className="border-b border-gray-800 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">{label}</h3>
          <span
            className={`rounded px-1.5 py-0.5 text-xs uppercase ${
              present
                ? 'bg-green-900/50 text-green-300'
                : 'bg-gray-800 text-gray-500'
            }`}
          >
            {headerChip}
          </span>
        </div>
        <p className="mt-0.5 font-mono text-xs text-gray-600">{domain}</p>
        {present ? (
          <div className="mt-2 space-y-1">
            {presence.slice(0, 3).map((row, i) => (
              <div
                key={`${row.source}-${row.strategyId ?? i}`}
                className="text-xs text-gray-400"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{strategyPresenceTitle(row)}</span>
                  {row.deepLink ? (
                    <a
                      href={row.deepLink}
                      className="shrink-0 text-blue-400 hover:underline"
                    >
                      {row.linkLabel ?? 'Open'}
                    </a>
                  ) : null}
                </div>
                {row.note ? (
                  <p className="mt-0.5 text-[11px] leading-snug text-gray-500">
                    {row.note}
                  </p>
                ) : null}
              </div>
            ))}
            {primary?.lastSeenAt ? (
              <p className="text-xs text-gray-600">
                last {new Date(primary.lastSeenAt).toLocaleString()}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-xs text-gray-600">No presence yet</p>
        )}
      </header>
      <ul className="max-h-[28rem] flex-1 overflow-y-auto">
        {activities.length === 0 ? (
          <li className="px-2 py-4 text-center text-xs text-gray-600">No recent activity</li>
        ) : (
          activities.map((item) => (
            <TokenMapActivityRow key={item.id} item={item} isNew={newIds.has(item.id)} />
          ))
        )}
      </ul>
    </section>
  )
}
