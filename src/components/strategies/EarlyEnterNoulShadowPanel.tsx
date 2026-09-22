'use client'

import { useCallback, useEffect, useState } from 'react'

type NoulShadowBand =
  | 'suppress'
  | 'mid'
  | 'keep'
  | 'skipped_null'
  | 'api_miss'

type NoulShadowDecision = 'keep' | 'suppress' | 'follow_spec'
type NoulSpecDecision = 'keep' | 'suppress'

type StrategyStats = {
  strategyKey: string
  total: number
  midBand: number
  midBandRate: number | null
  agreementEligible: number
  agreementMatches: number
  agreementRate: number | null
}

type ShadowListRow = {
  id: number
  predictedAt: string
  tokenAddress: string
  symbol: string | null
  chain: string
  strategyKey: string
  clMlScore: number | null
  specWouldPass: boolean
  noulCalled: boolean
  noul: number | null
  band: NoulShadowBand
  decisionShadow: NoulShadowDecision
  decisionSpec: NoulSpecDecision
}

const STRATEGY_KEYS = [
  'mcap_enter_first_seen',
  'mcap_enter_at_80',
  'mcap_enter_first_seen_rh',
  'mcap_enter_at_80_rh',
] as const

type ApiResponse = {
  success: boolean
  hours?: number
  shadowEnabled?: boolean
  softActive?: boolean
  hasTypeSafeCreds?: boolean
  total?: number
  byStrategy?: StrategyStats[]
  rows?: ShadowListRow[]
  rowsTotal?: number
  limit?: number
  offset?: number
  strategyKey?: string | null
  band?: NoulShadowBand | null
  error?: string
}

type Props = {
  onNotify?: (kind: 'success' | 'error', title: string, detail?: string) => void
}

const BANDS: NoulShadowBand[] = [
  'keep',
  'suppress',
  'mid',
  'api_miss',
  'skipped_null',
]

const PAGE_SIZE = 100

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function score(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(3)
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function bandChipClass(band: NoulShadowBand): string {
  switch (band) {
    case 'keep':
      return 'bg-emerald-900/70 text-emerald-200'
    case 'suppress':
      return 'bg-rose-900/70 text-rose-200'
    case 'mid':
      return 'bg-amber-900/60 text-amber-200'
    case 'api_miss':
      return 'bg-orange-900/60 text-orange-200'
    case 'skipped_null':
      return 'bg-gray-800 text-gray-400'
    default:
      return 'bg-gray-800 text-gray-300'
  }
}

function decisionChipClass(d: string): string {
  if (d === 'keep') return 'bg-emerald-900/50 text-emerald-200'
  if (d === 'suppress') return 'bg-rose-900/50 text-rose-200'
  return 'bg-slate-800 text-slate-300'
}

function Chip({
  label,
  className,
}: {
  label: string
  className: string
}) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${className}`}
    >
      {label}
    </span>
  )
}

export default function EarlyEnterNoulShadowPanel({ onNotify }: Props) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [hours, setHours] = useState(24)
  const [strategyKey, setStrategyKey] = useState('')
  const [band, setBand] = useState('')
  const [offset, setOffset] = useState(0)

  const load = useCallback(
    async (nextOffset: number) => {
      setLoading(true)
      try {
        const q = new URLSearchParams()
        q.set('hours', String(hours))
        q.set('limit', String(PAGE_SIZE))
        q.set('offset', String(nextOffset))
        if (strategyKey) q.set('strategy_key', strategyKey)
        if (band) q.set('band', band)
        const res = await fetch(
          `/api/strategies/ml/early-enter-noul-shadow?${q.toString()}`,
        )
        const json = (await res.json()) as ApiResponse
        if (!json.success) throw new Error(json.error ?? 'load failed')
        setData(json)
        setOffset(nextOffset)
      } catch (e) {
        onNotify?.(
          'error',
          'Noul shadow stats failed',
          e instanceof Error ? e.message : String(e),
        )
      } finally {
        setLoading(false)
      }
    },
    [onNotify, hours, strategyKey, band],
  )

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load(0)
    }, 0)
    return () => window.clearTimeout(t)
  }, [load])

  const statsRows = data?.byStrategy ?? []
  const funnelRows = data?.rows ?? []
  const rowsTotal = data?.rowsTotal ?? 0
  const showingFrom = rowsTotal === 0 ? 0 : offset + 1
  const showingTo = Math.min(offset + PAGE_SIZE, rowsTotal)

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Early Enter Noul shadow</h2>
          <p className="text-gray-400 text-sm">
            Shadow analytics — agreement / mid-band by strategy_key, plus per-token
            funnel (band + decisions).
          </p>
        </div>
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            data?.softActive
              ? 'bg-amber-900/60 text-amber-200'
              : data?.shadowEnabled === false
                ? 'bg-gray-800 text-gray-400'
                : 'bg-sky-900/60 text-sky-200'
          }`}
        >
          {data?.softActive ? 'soft-active' : data?.shadowEnabled === false ? 'off' : 'shadow'}
        </span>
      </div>

      {loading && !data ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : (
        <p className="text-xs text-gray-500">
          EARLY_ENTER_NOUL_SHADOW={data?.shadowEnabled ? '1' : '0'} · SOFT_ACTIVE=
          {data?.softActive ? '1' : '0'} · TYPESAFE=
          {data?.hasTypeSafeCreds ? 'set' : 'missing'} · aggregate rows{' '}
          {data?.total ?? 0}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Hours
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5"
          >
            <option value={6}>6</option>
            <option value={24}>24</option>
            <option value={48}>48</option>
            <option value={168}>168</option>
          </select>
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          strategy_key
          <select
            value={strategyKey}
            onChange={(e) => setStrategyKey(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5 max-w-[220px]"
          >
            <option value="">All</option>
            {STRATEGY_KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          band
          <select
            value={band}
            onChange={(e) => setBand(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5"
          >
            <option value="">All</option>
            {BANDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(offset)}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
        >
          Reload
        </button>
      </div>

      {statsRows.length === 0 ? (
        <p className="text-gray-500 text-sm">No shadow aggregates in this window.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-gray-400 border-b border-gray-700">
              <tr>
                <th className="py-2 pr-3 font-medium">strategy_key</th>
                <th className="py-2 pr-3 font-medium">N</th>
                <th className="py-2 pr-3 font-medium">Agreement</th>
                <th className="py-2 pr-3 font-medium">Mid-band</th>
              </tr>
            </thead>
            <tbody className="text-gray-200">
              {statsRows.map((r) => (
                <tr key={r.strategyKey} className="border-b border-gray-800">
                  <td className="py-2 pr-3 font-mono text-xs">{r.strategyKey}</td>
                  <td className="py-2 pr-3">{r.total}</td>
                  <td className="py-2 pr-3">
                    {pct(r.agreementRate)}
                    <span className="text-gray-500 text-xs ml-1">
                      ({r.agreementMatches}/{r.agreementEligible})
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {pct(r.midBandRate)}
                    <span className="text-gray-500 text-xs ml-1">
                      ({r.midBand}/{r.total})
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-gray-800 pt-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">Token funnel</h3>
          <p className="text-xs text-gray-500">
            {rowsTotal === 0
              ? 'No rows'
              : `Showing ${showingFrom}–${showingTo} of ${rowsTotal}`}
          </p>
        </div>

        {funnelRows.length === 0 ? (
          <p className="text-gray-500 text-sm">
            No shadowed tokens for this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left min-w-[720px]">
              <thead className="text-xs text-gray-400 border-b border-gray-700">
                <tr>
                  <th className="py-2 pr-2 font-medium">when</th>
                  <th className="py-2 pr-2 font-medium">token</th>
                  <th className="py-2 pr-2 font-medium">chain</th>
                  <th className="py-2 pr-2 font-medium">strategy</th>
                  <th className="py-2 pr-2 font-medium">cl_ml</th>
                  <th className="py-2 pr-2 font-medium">SPEC pass</th>
                  <th className="py-2 pr-2 font-medium">band</th>
                  <th className="py-2 pr-2 font-medium">shadow</th>
                  <th className="py-2 pr-2 font-medium">spec</th>
                  <th className="py-2 pr-2 font-medium">noul</th>
                </tr>
              </thead>
              <tbody className="text-gray-200">
                {funnelRows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-800 align-top">
                    <td className="py-2 pr-2 text-xs text-gray-400 whitespace-nowrap">
                      {formatWhen(r.predictedAt)}
                    </td>
                    <td className="py-2 pr-2">
                      <div className="font-medium text-white text-xs">
                        {r.symbol || '—'}
                      </div>
                      <div
                        className="font-mono text-[11px] text-gray-500"
                        title={r.tokenAddress}
                      >
                        {shortAddr(r.tokenAddress)}
                      </div>
                    </td>
                    <td className="py-2 pr-2 text-xs">{r.chain}</td>
                    <td className="py-2 pr-2 font-mono text-[11px] max-w-[140px] truncate" title={r.strategyKey}>
                      {r.strategyKey}
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs">{score(r.clMlScore)}</td>
                    <td className="py-2 pr-2">
                      <Chip
                        label={r.specWouldPass ? 'yes' : 'no'}
                        className={
                          r.specWouldPass
                            ? 'bg-emerald-900/50 text-emerald-200'
                            : 'bg-gray-800 text-gray-400'
                        }
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <Chip label={r.band} className={bandChipClass(r.band)} />
                    </td>
                    <td className="py-2 pr-2">
                      <Chip
                        label={r.decisionShadow}
                        className={decisionChipClass(r.decisionShadow)}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <Chip
                        label={r.decisionSpec}
                        className={decisionChipClass(r.decisionSpec)}
                      />
                    </td>
                    <td className="py-2 pr-2 font-mono text-xs text-gray-400">
                      {r.noulCalled ? score(r.noul) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading || offset <= 0}
            onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={loading || offset + PAGE_SIZE >= rowsTotal}
            onClick={() => void load(offset + PAGE_SIZE)}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
          >
            Next
          </button>
        </div>
      </div>
    </section>
  )
}
