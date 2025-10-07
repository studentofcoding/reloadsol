"use client"
import React, { useEffect, useMemo, useState } from "react"

type SignalItem = {
  token_address: string
  token_symbol?: string
  current_mcap?: number
  first_mcap?: number
  mcap_growth_percent?: number
  score?: number
  decision?: "enter" | "hold" | "exit" | "skip"
  rationale?: string
  first_seen_at?: string
  last_updated_at?: string
  when_reach_80mc?: string | null
  when_reach_120mc?: string | null
  when_reach_200mc?: string | null
  is_tracking_stuck?: boolean
}

type SignalsResponse = {
  success: boolean
  params?: Record<string, any>
  stats?: Record<string, any>
  signals?: SignalItem[]
}

const numberFmt = (n?: number) => {
  if (n === undefined || n === null || Number.isNaN(n)) return "—"
  return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)
}

const percentFmt = (p?: number) => {
  if (p === undefined || p === null || Number.isNaN(p)) return "—"
  return `${p.toFixed(2)}%`
}

const dateFmt = (iso?: string | null) => {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return "—"
    return d.toLocaleString()
  } catch {
    return "—"
  }
}

export default function TradingSignals() {
  const [limit, setLimit] = useState(50)
  const [recencyMinutes, setRecencyMinutes] = useState(240)
  const [minGrowth, setMinGrowth] = useState(0)
  const [includeStuck, setIncludeStuck] = useState(false)
  const [maxAgeMinutes, setMaxAgeMinutes] = useState(48 * 60)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>("")
  const [signals, setSignals] = useState<SignalItem[]>([])
  const [stats, setStats] = useState<Record<string, any>>({})

  const query = useMemo(() => {
    const params = new URLSearchParams()
    params.set("limit", String(limit))
    params.set("recencyMinutes", String(recencyMinutes))
    params.set("minGrowth", String(minGrowth))
    params.set("includeStuck", String(includeStuck))
    params.set("maxAgeMinutes", String(maxAgeMinutes))
    return params.toString()
  }, [limit, recencyMinutes, minGrowth, includeStuck, maxAgeMinutes])

  const fetchSignals = async () => {
    try {
      setLoading(true)
      setError("")
      const res = await fetch(`/api/trading/signals?${query}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`Failed to fetch signals (${res.status})`)
      const data: SignalsResponse = await res.json()
      if (!data.success) throw new Error("Signals API returned unsuccessful response")
      setSignals(data.signals || [])
      setStats(data.stats || {})
    } catch (e: any) {
      setError(e?.message || "Unknown error")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSignals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const decisionBadge = (d?: SignalItem["decision"]) => {
    const base = "px-2 py-0.5 rounded text-xs font-medium"
    switch (d) {
      case "enter":
        return <span className={`${base} bg-green-100 text-green-700`}>enter</span>
      case "hold":
        return <span className={`${base} bg-yellow-100 text-yellow-700`}>hold</span>
      case "exit":
        return <span className={`${base} bg-red-100 text-red-700`}>exit</span>
      case "skip":
        return <span className={`${base} bg-gray-100 text-gray-700`}>skip</span>
      default:
        return <span className={`${base} bg-gray-100 text-gray-700`}>n/a</span>
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end flex-wrap gap-3">
        <div>
          <label className="block text-sm font-medium">Limit</label>
          <input
            type="number"
            min={1}
            max={200}
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            className="mt-1 w-24 rounded border px-2 py-1"
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Recency (min)</label>
          <input
            type="number"
            min={0}
            value={recencyMinutes}
            onChange={e => setRecencyMinutes(Number(e.target.value))}
            className="mt-1 w-28 rounded border px-2 py-1"
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Min Growth (%)</label>
          <input
            type="number"
            min={0}
            value={minGrowth}
            onChange={e => setMinGrowth(Number(e.target.value))}
            className="mt-1 w-32 rounded border px-2 py-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <input
            id="includeStuck"
            type="checkbox"
            checked={includeStuck}
            onChange={e => setIncludeStuck(e.target.checked)}
          />
          <label htmlFor="includeStuck" className="text-sm font-medium">Include Stuck</label>
        </div>
        <div>
          <label className="block text-sm font-medium">Max Age (min)</label>
          <input
            type="number"
            min={0}
            value={maxAgeMinutes}
            onChange={e => setMaxAgeMinutes(Number(e.target.value))}
            className="mt-1 w-32 rounded border px-2 py-1"
          />
        </div>
        <button
          onClick={fetchSignals}
          className="ml-auto rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700"
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            <tr className="text-left text-sm">
              <th className="border-b p-2">Token</th>
              <th className="border-b p-2">Address</th>
              <th className="border-b p-2">Growth %</th>
              <th className="border-b p-2">Score</th>
              <th className="border-b p-2">Decision</th>
              <th className="border-b p-2">Rationale</th>
              <th className="border-b p-2">First Seen</th>
              <th className="border-b p-2">Last Updated</th>
              <th className="border-b p-2">80%</th>
              <th className="border-b p-2">120%</th>
              <th className="border-b p-2">200%</th>
              <th className="border-b p-2">Stuck</th>
            </tr>
          </thead>
          <tbody>
            {signals.length === 0 && !loading ? (
              <tr>
                <td className="p-4 text-center text-sm" colSpan={12}>No signals</td>
              </tr>
            ) : (
              signals.map((s) => (
                <tr key={`${s.token_address}-${s.last_updated_at || s.first_seen_at || "0"}`} className="text-sm">
                  <td className="border-b p-2">
                    <div className="font-medium">{s.token_symbol || "UNKNOWN"}</div>
                  </td>
                  <td className="border-b p-2">
                    <code className="text-xs">{s.token_address}</code>
                  </td>
                  <td className="border-b p-2">{percentFmt(s.mcap_growth_percent)}</td>
                  <td className="border-b p-2">{numberFmt(s.score)}</td>
                  <td className="border-b p-2">{decisionBadge(s.decision)}</td>
                  <td className="border-b p-2 max-w-xs">
                    <div className="truncate" title={s.rationale || ""}>{s.rationale || ""}</div>
                  </td>
                  <td className="border-b p-2">{dateFmt(s.first_seen_at)}</td>
                  <td className="border-b p-2">{dateFmt(s.last_updated_at)}</td>
                  <td className="border-b p-2">{dateFmt(s.when_reach_80mc)}</td>
                  <td className="border-b p-2">{dateFmt(s.when_reach_120mc)}</td>
                  <td className="border-b p-2">{dateFmt(s.when_reach_200mc)}</td>
                  <td className="border-b p-2">{s.is_tracking_stuck ? "Yes" : "No"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {stats && Object.keys(stats).length > 0 && (
        <div className="rounded border bg-gray-50 p-3 text-sm">
          <div className="font-medium mb-2">Stats</div>
          <pre className="overflow-x-auto text-xs">{JSON.stringify(stats, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}