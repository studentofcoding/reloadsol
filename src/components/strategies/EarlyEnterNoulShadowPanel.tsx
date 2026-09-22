'use client'

import { useCallback, useEffect, useState } from 'react'

type StrategyStats = {
  strategyKey: string
  total: number
  midBand: number
  midBandRate: number | null
  agreementEligible: number
  agreementMatches: number
  agreementRate: number | null
}

type ApiResponse = {
  success: boolean
  hours?: number
  shadowEnabled?: boolean
  softActive?: boolean
  hasTypeSafeCreds?: boolean
  total?: number
  byStrategy?: StrategyStats[]
  error?: string
}

type Props = {
  onNotify?: (kind: 'success' | 'error', title: string, detail?: string) => void
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

export default function EarlyEnterNoulShadowPanel({ onNotify }: Props) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ApiResponse | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/strategies/ml/early-enter-noul-shadow?hours=24')
      const json = (await res.json()) as ApiResponse
      if (!json.success) throw new Error(json.error ?? 'load failed')
      setData(json)
    } catch (e) {
      onNotify?.(
        'error',
        'Noul shadow stats failed',
        e instanceof Error ? e.message : String(e),
      )
    } finally {
      setLoading(false)
    }
  }, [onNotify])

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(t)
  }, [load])

  const rows = data?.byStrategy ?? []

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Early Enter Noul shadow</h2>
          <p className="text-gray-400 text-sm">
            Jev Noul beside soft gate — agreement vs SPEC and mid-band rate (last 24h), by
            strategy_key. Toast stays SPEC-owned until soft-active.
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
          {data?.hasTypeSafeCreds ? 'set' : 'missing'} · rows {data?.total ?? 0}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
        >
          Reload
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-gray-500 text-sm">No shadow rows in the last 24h.</p>
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
              {rows.map((r) => (
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
    </section>
  )
}
