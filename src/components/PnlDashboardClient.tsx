'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Daily paper-PnL progress: one screen, sized by a daily SOL budget and the sizing the system
 * actually applied.
 *
 * Reading it: `Capital` is `peak concurrent positions × the base stake` — the budget is a
 * *concurrency* constraint, because capital recycles, so anything over 100% means the day needed
 * more capital than the budget carries. `Flat` vs `Sized` is the same PnL at a flat stake and at the
 * stake the sizing pipeline (`ml_size_mult`) actually used; the gap is the sizing's effect.
 */

interface DailyRow {
  day: string
  regimeTag: string | null
  trades: number
  won: number
  lost: number
  sumPnlPct: number
  sumPnlPctWeighted: number
  pnlSolFlat: number
  pnlSolSized: number
  medianSizeMult: number | null
  withSizeMult: number
  withExec: number
  execPnlSol: number | null
  peakConcurrent: number
  capitalSol: number
  budgetUsedPct: number
  capacity: number
  sizedCapacity: number
}

interface SizingRow {
  sizeMult: number
  trades: number
  won: number
  lost: number
  sumPnlPct: number
  pnlSolSized: number
}

interface Summary {
  budgetSol: number
  basePositionSizeSol: number
  capacity: number
  days: number
  trades: number
  won: number
  lost: number
  winRatePct: number
  pnlSolFlat: number
  pnlSolSized: number
  sizingEffectPct: number
  pnlSolSizedPerDay: number
  tradesWithSizeMult: number
  medianSizeMult: number | null
  execPnlSol: number | null
  tradesWithExec: number
  peakConcurrent: number
  peakCapitalSol: number
  peakBudgetUsedPct: number
  bestDay: { day: string; pnlSol: number } | null
  worstDay: { day: string; pnlSol: number } | null
}

interface Payload {
  success: boolean
  daily?: DailyRow[]
  sizing?: SizingRow[]
  summary?: Summary
  config?: { budgetSol: number; basePositionSizeSol: number }
  error?: string
}

interface Climate {
  state?: string | null
  sizeKind?: string
  scale?: number
}

const RANGES = [7, 14, 30, 90]

const sol = (v: number, d = 4) => `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(d)}`
const pct = (v: number, d = 1) => `${v.toFixed(d)}%`
const tone = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-400')

export default function PnlDashboardClient() {
  const [days, setDays] = useState(14)
  const [data, setData] = useState<Payload | null>(null)
  const [climate, setClimate] = useState<Climate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const to = new Date()
      const from = new Date(to.getTime() - (days - 1) * 86_400_000)
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      const res = await fetch(`/api/pnl/daily?from=${iso(from)}&to=${iso(to)}`)
      const body = (await res.json()) as Payload
      if (!body.success) throw new Error(body.error || 'Request failed')
      setData(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [days])

  const loadClimate = useCallback(async () => {
    try {
      const res = await fetch('/api/regime/climate')
      const body = (await res.json()) as Climate
      setClimate(body)
    } catch {
      setClimate(null)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadClimate()
  }, [load, loadClimate])

  const summary = data?.summary
  const rows = data?.daily ?? []
  const sizing = data?.sizing ?? []
  const maxAbs = useMemo(() => Math.max(0.0001, ...rows.map((r) => Math.abs(r.pnlSolSized))), [rows])

  return (
    <div className="min-h-screen bg-gray-950 text-white px-6 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Paper PnL progress</h1>
            <p className="text-gray-400 text-sm mt-1">
              Simulated trades only. Capital = peak concurrent positions × the base stake; the budget
              is a concurrency limit because capital recycles.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {climate?.state ? (
              <span className="px-3 py-1.5 text-xs rounded border border-gray-700 bg-gray-900 text-gray-300">
                brain climate: <span className="text-white">{climate.state}</span>
                {climate.scale ? ` · sizeScale ${climate.scale}` : ''}
              </span>
            ) : null}
            <div className="flex rounded border border-gray-700 overflow-hidden">
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => setDays(r)}
                  className={`px-3 py-1.5 text-sm ${days === r ? 'bg-emerald-800 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-800'}`}
                >
                  {r}d
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                void load()
                void loadClimate()
              }}
              className="px-3 py-1.5 text-sm rounded bg-gray-800 hover:bg-gray-700"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </header>

        {error ? (
          <div className="rounded border border-red-800 bg-red-950/40 px-4 py-3 text-red-300 text-sm">{error}</div>
        ) : null}

        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Budget / day" value={`${sol(summary?.budgetSol ?? 0, 3)} SOL`} sub={`base stake ${sol(summary?.basePositionSizeSol ?? 0, 4)} · capacity ${summary?.capacity ?? 0}`} />
          <Stat
            label="PnL (sized)"
            value={`${sol(summary?.pnlSolSized ?? 0)} SOL`}
            sub={`${sol(summary?.pnlSolSizedPerDay ?? 0)}/day · flat ${sol(summary?.pnlSolFlat ?? 0)} (${pct(summary?.sizingEffectPct ?? 0, 0)} sizing effect)`}
            tone={tone(summary?.pnlSolSized ?? 0)}
          />
          <Stat
            label="Peak capital"
            value={`${sol(summary?.peakCapitalSol ?? 0, 3)} SOL`}
            sub={`${summary?.peakConcurrent ?? 0} open · ${pct(summary?.peakBudgetUsedPct ?? 0, 0)} of budget`}
            tone={(summary?.peakBudgetUsedPct ?? 0) > 100 ? 'text-amber-400' : 'text-gray-200'}
          />
          <Stat
            label="Trades"
            value={`${summary?.trades ?? 0}`}
            sub={`${summary?.won ?? 0}W / ${summary?.lost ?? 0}L · ${pct(summary?.winRatePct ?? 0)} win · sized ${summary?.tradesWithSizeMult ?? 0}`}
          />
        </section>

        {/* The sizing the system actually applied */}
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Sizing applied (ml_size_mult)</h2>
            <span className="text-xs text-gray-500">
              median {summary?.medianSizeMult != null ? summary.medianSizeMult.toFixed(3) : '—'} ·{' '}
              {summary?.tradesWithSizeMult ?? 0} of {summary?.trades ?? 0} trades stamped
            </span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-800">
                  <th className="py-1.5 pr-4">Multiplier</th>
                  <th className="py-1.5 pr-4">Stake</th>
                  <th className="py-1.5 pr-4">Trades</th>
                  <th className="py-1.5 pr-4">W / L</th>
                  <th className="py-1.5 pr-4">PnL %</th>
                  <th className="py-1.5">PnL SOL (sized)</th>
                </tr>
              </thead>
              <tbody>
                {sizing.map((s) => (
                  <tr key={s.sizeMult} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-4 text-gray-300">{s.sizeMult.toFixed(3)}×</td>
                    <td className="py-1.5 pr-4 text-gray-400">
                      {sol((summary?.basePositionSizeSol ?? 0.005) * s.sizeMult, 4)}
                    </td>
                    <td className="py-1.5 pr-4 text-gray-300">{s.trades}</td>
                    <td className="py-1.5 pr-4 text-gray-300">
                      {s.won} / {s.lost}
                    </td>
                    <td className={`py-1.5 pr-4 ${tone(s.sumPnlPct)}`}>{pct(s.sumPnlPct, 0)}</td>
                    <td className={`py-1.5 ${tone(s.pnlSolSized)}`}>{sol(s.pnlSolSized)}</td>
                  </tr>
                ))}
                {sizing.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-3 text-gray-500">
                      Nothing closed in this range.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            This is the existing sizing pipeline, not a new one: `ml_size_mult` is stamped by
            `ml-soft-size.ts`, and the brain&apos;s climate scale feeds the same stake. The
            `market_regime_tags` table is a separate vocabulary that stopped in July and is on no
            recent close, so it is not used as the sizing axis here.
          </p>
        </section>

        {/* Daily table */}
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <h2 className="font-semibold">Daily progress</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-800">
                  <th className="py-1.5 pr-4">Day</th>
                  <th className="py-1.5 pr-4">Trades</th>
                  <th className="py-1.5 pr-4">W / L</th>
                  <th className="py-1.5 pr-4">PnL %</th>
                  <th className="py-1.5 pr-4">PnL SOL</th>
                  <th className="py-1.5 pr-4 w-32"> </th>
                  <th className="py-1.5 pr-4">Flat</th>
                  <th className="py-1.5 pr-4">Median ×</th>
                  <th className="py-1.5 pr-4">Open</th>
                  <th className="py-1.5 pr-4">Capital</th>
                  <th className="py-1.5">Budget</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.day} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-4 text-gray-300">{r.day}</td>
                    <td className="py-1.5 pr-4 text-gray-300">{r.trades}</td>
                    <td className="py-1.5 pr-4 text-gray-300">
                      {r.won} / {r.lost}
                    </td>
                    <td className={`py-1.5 pr-4 ${tone(r.sumPnlPctWeighted)}`}>{pct(r.sumPnlPctWeighted, 0)}</td>
                    <td className={`py-1.5 pr-4 ${tone(r.pnlSolSized)}`}>{sol(r.pnlSolSized)}</td>
                    <td className="py-1.5 pr-4">
                      <div className="h-2 rounded bg-gray-800 relative overflow-hidden">
                        <div
                          className={`h-full ${r.pnlSolSized >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}
                          style={{ width: `${Math.min(100, (Math.abs(r.pnlSolSized) / maxAbs) * 100)}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-1.5 pr-4 text-gray-400">{sol(r.pnlSolFlat)}</td>
                    <td className="py-1.5 pr-4 text-gray-400">
                      {r.medianSizeMult != null ? `${r.medianSizeMult.toFixed(2)}×` : '—'}
                    </td>
                    <td className="py-1.5 pr-4 text-gray-300">{r.peakConcurrent}</td>
                    <td className="py-1.5 pr-4 text-gray-300">{sol(r.capitalSol, 3)}</td>
                    <td className={`py-1.5 ${r.budgetUsedPct > 100 ? 'text-amber-400' : 'text-gray-300'}`}>
                      {pct(r.budgetUsedPct, 0)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-3 text-gray-500">
                      Nothing closed in this range.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            Best {summary?.bestDay ? `${summary.bestDay.day} ${sol(summary.bestDay.pnlSol)}` : '—'} · worst{' '}
            {summary?.worstDay ? `${summary.worstDay.day} ${sol(summary.worstDay.pnlSol)}` : '—'} ·{' '}
            {summary?.tradesWithExec
              ? `${summary.tradesWithExec} trades carry a real-fill execution record (${sol(summary.execPnlSol ?? 0)} SOL): the gap to the sized PnL is the modelled slippage and impact drag.`
              : 'No execution records yet — PnL here is the price-ratio figure, before slippage and impact.'}
          </p>
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, tone: toneClass }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${toneClass ?? 'text-white'}`}>{value}</div>
      {sub ? <div className="text-xs text-gray-500 mt-0.5">{sub}</div> : null}
    </div>
  )
}
