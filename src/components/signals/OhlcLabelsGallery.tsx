'use client'

import { useQuery } from '@tanstack/react-query'
import AlgoTesterOhlcChart, {
  type StoredOhlcBar,
} from '@/components/algo-tester/AlgoTesterOhlcChart'
import TokenSearchLink from '@/components/signals/shared/TokenSearchLink'
import { formatAppDateTime } from '@/utils/datetime'

type LabelRow = {
  id: string
  token_address: string
  token_symbol: string | null
  label: 'potential' | 'rug'
  window_start: string
  window_end: string
  ohlc_source: string
  bars: StoredOhlcBar[]
  end_reason: string | null
  source: string | null
  created_at: string
}

function Section({
  title,
  label,
  accent,
}: {
  title: string
  label: 'potential' | 'rug'
  accent: string
}) {
  const query = useQuery({
    queryKey: ['signal-ohlc-labels', label],
    queryFn: async (): Promise<LabelRow[]> => {
      const res = await fetch(
        `/api/signals/ohlc-labels?label=${label}&limit=40`,
      )
      const json = (await res.json()) as {
        success?: boolean
        entries?: LabelRow[]
        error?: string
      }
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load OHLC labels')
      }
      return json.entries ?? []
    },
    staleTime: 30_000,
  })

  return (
    <section className="space-y-3">
      <h2 className={`text-lg font-semibold ${accent}`}>{title}</h2>
      {query.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : null}
      {query.error ? (
        <p className="text-sm text-amber-300">
          {query.error instanceof Error
            ? query.error.message
            : 'Failed to load'}
        </p>
      ) : null}
      {!query.isLoading && (query.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-gray-500">
          No snapshots yet. Label tokens Potential / Rugged on Signals.
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {(query.data ?? []).map((row) => (
          <article
            key={row.id}
            className="rounded-lg border border-gray-700 bg-gray-900/80 p-3"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-white">
                {row.token_symbol || 'UNKNOWN'}
              </span>
              <TokenSearchLink address={row.token_address} />
              <span className="font-mono text-[10px] text-gray-500">
                {row.token_address.slice(0, 8)}…
              </span>
            </div>
            <p className="mb-2 text-[11px] text-gray-400">
              {formatAppDateTime(row.window_start)} →{' '}
              {formatAppDateTime(row.window_end)}
              {row.end_reason ? (
                <span className="ml-2 text-gray-500">· {row.end_reason}</span>
              ) : null}
            </p>
            <AlgoTesterOhlcChart
              tokenAddress={row.token_address}
              fromIso={row.window_start}
              toIso={row.window_end}
              bars={Array.isArray(row.bars) ? row.bars : []}
              ohlcSource={row.ohlc_source}
              height={220}
            />
          </article>
        ))}
      </div>
    </section>
  )
}

export default function OhlcLabelsGallery() {
  return (
    <div className="space-y-10">
      <Section
        title="Potential"
        label="potential"
        accent="text-emerald-300"
      />
      <Section title="Rug" label="rug" accent="text-red-300" />
    </div>
  )
}
