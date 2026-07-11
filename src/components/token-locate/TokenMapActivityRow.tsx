'use client'

import type { TokenMapActivityItem } from '@/strategies/token-map-types'

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const KIND_CLASS: Record<string, string> = {
  gmgn_hot: 'text-amber-300',
  live_boost: 'text-amber-200',
  sim_open: 'text-green-300',
  sim_close: 'text-blue-300',
  outcome: 'text-purple-300',
  social_event: 'text-gray-300',
}

export default function TokenMapActivityRow({
  item,
  isNew,
}: {
  item: TokenMapActivityItem
  isNew?: boolean
}) {
  return (
    <li
      className={`border-b border-gray-800/80 px-2 py-2 text-xs last:border-0 ${
        isNew ? 'animate-pulse bg-blue-950/40' : ''
      }`}
    >
      <div className={`font-medium ${KIND_CLASS[item.kind] ?? 'text-gray-300'}`}>
        {item.title}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-2 text-gray-500">
        <span>{formatWhen(item.occurredAt)}</span>
        {item.detail ? <span>{item.detail}</span> : null}
      </div>
    </li>
  )
}
