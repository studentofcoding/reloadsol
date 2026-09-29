'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

type DevTokenRef = {
  address: string
  symbol: string | null
  athMc: number | null
  marketCap: number | null
  liquidity: number | null
  holders: number | null
  graduated: boolean
  launchpad: string | null
  createdAt: number | null
}

type DevRow = {
  creator_address: string
  verdict: 'ban' | 'good' | 'inconclusive' | 'unknown'
  sample: number
  open_count: number
  inner_count: number
  graduation_ratio: number | null
  ath_mc: number | null
  reasons: string[] | null
  tokens: DevTokenRef[] | null
  mode: string
  evaluated_at: string
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function fmtPct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(1)}%`
}

function short(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr
}

function verdictClass(v: DevRow['verdict']): string {
  if (v === 'ban') return 'border-red-500/40 bg-red-950/40 text-red-200'
  if (v === 'good') return 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'
  return 'border-gray-600 bg-gray-900/60 text-gray-300'
}

function DevTokens({ tokens }: { tokens: DevTokenRef[] }) {
  if (tokens.length === 0) {
    return <p className="px-2 py-1 text-[11px] text-gray-500">No token list stored.</p>
  }
  return (
    <table className="w-full text-[11px]">
      <thead className="text-gray-500">
        <tr>
          <th className="px-2 py-1 text-left font-medium">Token</th>
          <th className="px-2 py-1 text-right font-medium">Mcap</th>
          <th className="px-2 py-1 text-right font-medium">ATH mc</th>
          <th className="px-2 py-1 text-right font-medium">Holders</th>
          <th className="px-2 py-1 text-left font-medium">Launchpad</th>
          <th className="px-2 py-1 text-center font-medium">Grad</th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((t) => (
          <tr key={t.address} className="border-t border-gray-800">
            <td className="px-2 py-1">
              <a
                className="text-blue-400 hover:text-blue-300"
                href={`https://gmgn.ai/sol/token/${t.address}`}
                target="_blank"
                rel="noreferrer"
              >
                {t.symbol ?? short(t.address)}
              </a>
            </td>
            <td className="px-2 py-1 text-right text-gray-300">{fmtUsd(t.marketCap)}</td>
            <td className="px-2 py-1 text-right text-gray-300">{fmtUsd(t.athMc)}</td>
            <td className="px-2 py-1 text-right text-gray-300">{t.holders ?? '—'}</td>
            <td className="px-2 py-1 text-gray-400">{t.launchpad ?? '—'}</td>
            <td className="px-2 py-1 text-center">
              {t.graduated ? (
                <span className="text-emerald-300">yes</span>
              ) : (
                <span className="text-gray-500">no</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DevList({ verdict, title, blurb }: { verdict: 'good' | 'ban'; title: string; blurb: string }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data, isLoading, error } = useQuery({
    queryKey: ['dev-reputation', verdict],
    queryFn: async (): Promise<DevRow[]> => {
      const res = await fetch(`/api/dev/reputation?verdict=${verdict}&limit=100`)
      const json = (await res.json()) as { success: boolean; rows?: DevRow[]; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load devs')
      return json.rows ?? []
    },
    staleTime: 60_000,
  })

  const rows = useMemo(() => data ?? [], [data])

  return (
    <section className="rounded-lg border border-gray-700 bg-gray-950/60 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <span className="text-[11px] text-gray-500">{rows.length} devs</span>
      </div>
      <p className="mb-2 text-[11px] text-gray-500">{blurb}</p>

      {isLoading ? <p className="text-xs text-gray-400">Loading…</p> : null}
      {error ? (
        <p className="text-xs text-amber-300">{error instanceof Error ? error.message : 'Error'}</p>
      ) : null}
      {!isLoading && rows.length === 0 ? (
        <p className="text-xs text-gray-500">No devs in this bucket yet.</p>
      ) : null}

      <div className="space-y-1.5">
        {rows.map((dev) => {
          const open = expanded === dev.creator_address
          return (
            <div
              key={dev.creator_address}
              className="rounded border border-gray-800 bg-gray-900/50"
            >
              <button
                type="button"
                onClick={() => setExpanded(open ? null : dev.creator_address)}
                className="flex w-full flex-wrap items-center gap-2 px-2 py-1.5 text-left"
              >
                <span className={`rounded border px-1 py-0.5 text-[10px] font-semibold uppercase ${verdictClass(dev.verdict)}`}>
                  {dev.verdict}
                </span>
                <a
                  className="text-xs text-blue-400 hover:text-blue-300"
                  href={`https://gmgn.ai/sol/address/${dev.creator_address}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {short(dev.creator_address)}
                </a>
                <span className="text-[11px] text-gray-400">
                  created {dev.sample} · {dev.open_count} grad · {fmtPct(dev.graduation_ratio)}
                </span>
                <span className="text-[11px] text-gray-400">ATH {fmtUsd(dev.ath_mc)}</span>
                <span className="ml-auto text-[10px] text-gray-500">{open ? '▲' : '▼'} top {dev.tokens?.length ?? 0}</span>
              </button>
              {dev.reasons && dev.reasons.length > 0 ? (
                <p className="px-2 pb-1 text-[11px] text-gray-500">{dev.reasons.join(' · ')}</p>
              ) : null}
              {open ? (
                <div className="overflow-x-auto border-t border-gray-800 bg-black/20">
                  <DevTokens tokens={dev.tokens ?? []} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function DevReputationHub() {
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-gray-500">
        Shadow-first — verdicts are advisory and do not gate anything yet. Data is
        the stored dev reputation (GMGN created_tokens aggregates + top tokens by
        ATH). Tokens are capped at 10 per dev.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <DevList
          verdict="good"
          title="Profitable devs"
          blurb="High graduation rate (≥25%) with a real ATH (≥$1M). Ranked by ATH."
        />
        <DevList
          verdict="ban"
          title="Ban list"
          blurb="Serial launchers: graduation ≤5% over a meaningful sample. Ranked by ATH."
        />
      </div>
    </div>
  )
}
