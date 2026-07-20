'use client'

import { useQuery } from '@tanstack/react-query'
import MiniOhlcCandles, {
  type MiniOhlcBar,
} from '@/components/signals/shared/MiniOhlcCandles'
import TokenSearchLink from '@/components/signals/shared/TokenSearchLink'
import { formatAppDateTime } from '@/utils/datetime'

const CLIENT_TTL_MS = 10 * 60 * 1000

type LabelRow = {
  id: string
  token_address: string
  token_symbol: string | null
  label: 'potential' | 'rug'
  window_start: string
  window_end: string
  ohlc_source: string
  bars: MiniOhlcBar[]
  end_reason: string | null
  source: string | null
  created_at: string
}

function sessionKey(label: 'potential' | 'rug'): string {
  return `signal-ohlc-labels:v1:${label}`
}

function readSession(label: 'potential' | 'rug'): LabelRow[] | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = sessionStorage.getItem(sessionKey(label))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { at: number; entries: LabelRow[] }
    if (
      !parsed?.at ||
      Date.now() - parsed.at > CLIENT_TTL_MS ||
      !Array.isArray(parsed.entries)
    ) {
      return undefined
    }
    return parsed.entries
  } catch {
    return undefined
  }
}

function writeSession(label: 'potential' | 'rug', entries: LabelRow[]): void {
  try {
    sessionStorage.setItem(
      sessionKey(label),
      JSON.stringify({ at: Date.now(), entries }),
    )
  } catch {
    /* quota */
  }
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
  const initial = readSession(label)

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
      const entries = json.entries ?? []
      writeSession(label, entries)
      return entries
    },
    initialData: initial,
    staleTime: CLIENT_TTL_MS,
    gcTime: CLIENT_TTL_MS,
    // Warm session: skip network until stale
    refetchOnMount: initial ? false : true,
    refetchOnWindowFocus: false,
  })

  return (
    <section className="space-y-3">
      <h2 className={`text-lg font-semibold ${accent}`}>{title}</h2>
      {query.isLoading && !query.data ? (
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
              {row.ohlc_source ? (
                <span className="ml-2 text-gray-600">· {row.ohlc_source}</span>
              ) : null}
            </p>
            <MiniOhlcCandles
              bars={Array.isArray(row.bars) ? row.bars : []}
              className="h-28 w-full"
              emptyLabel="No OHLC bars"
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
