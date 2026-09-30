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
  velocityMaxSol: number
  velocityMaxPct: number
  optimalBudgetSol: number
  meanSizeMult: number
  winRatePct: number
  avgRiskSol: number
  avgRewardSol: number
  winLossRatio: number | null
  profitFactor: number | null
  grossWinPct: number
  grossLossPct: number
  avgWinPct: number
  avgLossPct: number
  bestPnlPct: number
  worstPnlPct: number
}

interface DayTrade {
  strategy_id: string
  token_address: string
  token_symbol: string | null
  pnl_pct: string | null
  status: string | null
  regime_tag: string | null
  has_exec: boolean
  entry_at: string | null
  exit_at: string | null
}

interface OpenPosition {
  token_address: string
  token_symbol: string
  strategy_id: string | null
  position_size: string
  entry_price: string
  current_price: string
  stop_loss_price: string
  take_profit_price: string
  created_at: string
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
  costModel?: {
    feeBps: number
    spreadBps: number
    priorityFeeQuote: number
    impactCoeff: number
  }
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
  avgWinPct: number
  avgLossPct: number
  avgRiskSol: number
  avgRewardSol: number
  winLossRatio: number | null
  profitFactor: number | null
  velocityMaxSol: number
  suggestedDailyBudgetSol: number
  budgetHeadroom: number
  budgetAdequate: boolean
}

interface LedgerSummary {
  positions: number
  closed: number
  open: number
  realizedPnlSol: number
  realizedPnlPct: number
  costSol: number
  won: number
  lost: number
  winRatePct: number
  grossWinSol: number
  grossLossSol: number
  profitFactor: number | null
  modelledDragSol: number
  realizedNetSol: number
}

interface ClosedPosition {
  strategyId: string | null
  symbol: string | null
  mintAddress: string
  costSol: number
  proceedsSol: number
  pnlSol: number
  pnlPct: number
  closedAt: number | null
}

interface LedgerPayload {
  /** Per-strategy readiness from the ledger: net of the calibrated drag, best first. */
  readiness?: Array<{
    strategyId: string
    closed: number
    medianPnlPct: number
    medianSizeSol: number
    grossSol: number
    dragSol: number
    netSol: number
    netPerTradeSol: number
    peakConcurrent: number
    excludedNominal: number
    /** Gated by the sample floor; `verdictUngated` is the raw judgement, for the toggle. */
    verdict: 'candidate' | 'marginal' | 'not_viable' | 'insufficient'
    verdictUngated: 'candidate' | 'marginal' | 'not_viable'
    minSample: number
  }>
  success: boolean
  records?: number
  summary?: LedgerSummary
  strategies?: Array<LedgerSummary & { strategyId: string }>
  recentClosed?: ClosedPosition[]
  error?: string
}

interface RegimeRow {
  regimeTag: string | null
  trades: number
  won: number
  lost: number
  sumPnlPct: number
  pnlSolFlat: number
}

interface Payload {
  success: boolean
  range?: { from: string; to: string; timezone: string }
  daily?: DailyRow[]
  open_positions?: OpenPosition[]
  regimes?: RegimeRow[]
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

/** Today in the operator's timezone, so "today" matches the day the sims trade in. */
function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const sol = (v: number, d = 4) => `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(d)}`
const pct = (v: number, d = 1) => `${v.toFixed(d)}%`
const tone = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-400')

export default function PnlDashboardClient() {
  // Anchored on today, but the anchor is NOT read during render: this component prerenders at build
  // time, and Next rejects a current-time read there (blocking-prerender-current-time-client). The
  // dates start empty and are set on mount, which also keeps the server and client markup identical.
  const [today, setToday] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dayTrades, setDayTrades] = useState<Record<string, DayTrade[]>>({})
  const [dayLoading, setDayLoading] = useState<string | null>(null)
  const [ledger, setLedger] = useState<LedgerPayload | null>(null)
  // The sample floor is a view, not a computation: both verdicts arrive from the API, so this toggle
  // costs nothing and lets you see the table with the gate on, or everything ungated.
  const [gateSample, setGateSample] = useState(true)
  const [showOpen, setShowOpen] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [climate, setClimate] = useState<Climate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!from || !to) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/pnl/daily?from=${from}&to=${to}`)
      const body = (await res.json()) as Payload
      if (!body.success) throw new Error(body.error || 'Request failed')
      setData(body)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [from, to])

  const applyPreset = useCallback((n: number) => {
    const anchor = todayIso()
    setTo(anchor)
    setFrom(shiftDays(anchor, -(n - 1)))
  }, [])

  /** Expand a day: fetch its closed trades once, then toggle. */
  const toggleDay = useCallback(
    async (day: string) => {
      if (expanded === day) {
        setExpanded(null)
        return
      }
      setExpanded(day)
      if (dayTrades[day]) return
      setDayLoading(day)
      try {
        const res = await fetch(`/api/pnl/day?date=${day}`)
        const body = (await res.json()) as { success: boolean; trades?: DayTrade[] }
        setDayTrades((prev) => ({ ...prev, [day]: body.trades ?? [] }))
      } catch {
        setDayTrades((prev) => ({ ...prev, [day]: [] }))
      } finally {
        setDayLoading(null)
      }
    },
    [expanded, dayTrades],
  )

  const loadClimate = useCallback(async () => {
    try {
      const res = await fetch('/api/regime/climate')
      const body = (await res.json()) as Climate
      setClimate(body)
    } catch {
      setClimate(null)
    }
  }, [])

  // Anchor on mount (the one place reading the clock is allowed), then keep the climate fresh.
  useEffect(() => {
    const anchor = todayIso()
    setToday(anchor)
    setFrom(anchor)
    setTo(anchor)
    void loadClimate()
  }, [loadClimate])

  useEffect(() => {
    void load()
  }, [load])

  // Ledger view: realized PnL from the recorded sim cash flows, independent of the outcome rows.
  useEffect(() => {
    if (!from || !to) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/pnl/ledger?from=${from}&to=${to}`)
        const body = (await res.json()) as LedgerPayload
        if (!cancelled) setLedger(body)
      } catch {
        if (!cancelled) setLedger(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [from, to])

  const summary = data?.summary
  const rows = data?.daily ?? []
  const sizing = data?.sizing ?? []
  const regimes = data?.regimes ?? []
  const openPositions = data?.open_positions ?? []
  const maxAbs = useMemo(() => Math.max(0.0001, ...rows.map((r) => Math.abs(r.pnlSolSized))), [rows])

  return (
    <div className="min-h-screen bg-gray-950 text-white px-6 py-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Paper PnL progress</h1>
            <p className="text-gray-400 text-sm mt-1">
              {data?.range
                ? `${data.range.from === data.range.to ? 'Single day' : 'Range'} ${data.range.from}${data.range.from === data.range.to ? '' : ` → ${data.range.to}`} (${data.range.timezone}) · `
                : ''}
              budget per day {sol(summary?.budgetSol ?? 0, 2)} SOL · velocity = peak concurrent
              capital × stake, which is the binding number because capital recycles.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {climate?.state ? (
              <span className="px-3 py-1.5 text-xs rounded border border-gray-700 bg-gray-900 text-gray-300">
                brain climate: <span className="text-white">{climate.state}</span>
                {climate.scale ? ` · sizeScale ${climate.scale}` : ''}
              </span>
            ) : null}
            <label className="text-xs text-gray-400">
              From
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value || todayIso())}
                className="block mt-0.5 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white"
              />
            </label>
            <label className="text-xs text-gray-400">
              To
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value || todayIso())}
                className="block mt-0.5 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-white"
              />
            </label>
            <div className="flex rounded border border-gray-700 overflow-hidden">
              <button
                onClick={() => {
                  setFrom(shiftDays(from, -1))
                  setTo(shiftDays(to, -1))
                }}
                disabled={!from || !to}
                title="Previous day"
                aria-label="Previous day"
                className="px-3 py-1.5 text-sm bg-gray-900 text-gray-300 hover:bg-gray-800 disabled:opacity-40"
              >
                ◀
              </button>
              <button
                onClick={() => {
                  setFrom(shiftDays(from, 1))
                  setTo(shiftDays(to, 1))
                }}
                disabled={!from || !to || to >= todayIso()}
                title="Next day"
                aria-label="Next day"
                className="px-3 py-1.5 text-sm bg-gray-900 text-gray-300 hover:bg-gray-800 disabled:opacity-40"
              >
                ▶
              </button>
            </div>
            <button
              onClick={() => {
                const anchor = todayIso()
                setToday(anchor)
                setFrom(anchor)
                setTo(anchor)
              }}
              className={`px-3 py-1.5 text-sm rounded border border-gray-700 ${today && from === to && to === today ? 'bg-emerald-800 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-800'}`}
            >
              Today
            </button>
            <div className="flex rounded border border-gray-700 overflow-hidden">
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => applyPreset(r)}
                  className="px-2.5 py-1.5 text-xs bg-gray-900 text-gray-300 hover:bg-gray-800"
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
          <Stat
            label="Budget / day"
            value={`${sol(summary?.budgetSol ?? 0, 3)} SOL`}
            sub={`base ${sol(summary?.basePositionSizeSol ?? 0, 4)} · capacity ${summary?.capacity ?? 0} · suggested ${sol(summary?.suggestedDailyBudgetSol ?? 0, 3)} (${summary?.budgetHeadroom ?? 1.25}× headroom)`}
            tone={(summary?.budgetAdequate ?? true) ? 'text-gray-200' : 'text-amber-400'}
          />
          <Stat
            label="PnL (sized)"
            value={`${sol(summary?.pnlSolSized ?? 0)} SOL`}
            sub={`${sol(summary?.pnlSolSizedPerDay ?? 0)}/day · flat ${sol(summary?.pnlSolFlat ?? 0)} (${pct(summary?.sizingEffectPct ?? 0, 0)} sizing effect)`}
            tone={tone(summary?.pnlSolSized ?? 0)}
          />
          <Stat
            label="Velocity max"
            value={`${sol(summary?.velocityMaxSol ?? 0, 3)} SOL`}
            sub={`${summary?.peakConcurrent ?? 0} open at once · ${pct(summary?.peakBudgetUsedPct ?? 0, 0)} of budget`}
            tone={(summary?.peakBudgetUsedPct ?? 0) > 100 ? 'text-amber-400' : 'text-gray-200'}
          />
          <Stat
            label="Cost model"
            value={`${((summary?.costModel?.feeBps ?? 12) + (summary?.costModel?.spreadBps ?? 0)) * 2} bps round trip`}
            sub={`fee ${summary?.costModel?.feeBps ?? 12}/side + spread ${summary?.costModel?.spreadBps ?? 0}/side · priority ${sol(summary?.costModel?.priorityFeeQuote ?? 0.00003, 5)} SOL/side — measured from live quotes (~26 bps); the old constants charged 300`}
            tone="text-gray-200"
          />
          <Stat
            label="Trades"
            value={`${summary?.trades ?? 0}`}
            sub={`${summary?.won ?? 0}W / ${summary?.lost ?? 0}L · ${pct(summary?.winRatePct ?? 0)} win · sized ${summary?.tradesWithSizeMult ?? 0}`}
          />
        </section>

        {/* Per-strategy readiness. The decision this is for: is a strategy worth arming, judged at the
            size and the cost we would actually trade — not on a mean that one winner carries, and not
            gross of the drag. */}
        {(ledger?.readiness ?? []).length > 0 ? (
          <section className="mt-4">
            <div className="flex items-baseline justify-between mb-2 gap-3">
              <h2 className="text-sm text-gray-300">
                Strategy readiness <span className="text-gray-500">— net of the calibrated drag</span>
              </h2>
              <button
                type="button"
                onClick={() => setGateSample((v) => !v)}
                className="text-[10px] uppercase tracking-wide px-2 py-1 rounded border border-gray-700 text-gray-300 hover:border-gray-500"
                title="Minimum-sample gate: below the floor the verdict reads 'insufficient', because a median on a handful of trades is noise."
              >
                sample gate: {gateSample ? `on (n≥${ledger!.readiness![0]?.minSample ?? 30})` : 'off'}
              </button>
            </div>
            <div className="overflow-x-auto rounded border border-gray-800">
              <table className="w-full text-xs">
                <thead className="bg-gray-900 text-gray-400">
                  <tr>
                    <th className="text-left py-1.5 pl-2 pr-3 font-medium">Strategy</th>
                    <th className="text-right py-1.5 px-2 font-medium">Closed</th>
                    <th className="text-right py-1.5 px-2 font-medium">Median %</th>
                    <th className="text-right py-1.5 px-2 font-medium">Median size</th>
                    <th className="text-right py-1.5 px-2 font-medium">Gross</th>
                    <th className="text-right py-1.5 px-2 font-medium">Drag</th>
                    <th className="text-right py-1.5 px-2 font-medium">Net / trade</th>
                    <th className="text-right py-1.5 px-2 font-medium">Peak open</th>
                    <th className="text-left py-1.5 pl-2 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger!.readiness!.map((r) => (
                    <tr key={r.strategyId} className="border-t border-gray-800">
                      <td className="py-1 pl-2 pr-3 text-gray-200">{r.strategyId}</td>
                      <td className="py-1 px-2 text-right text-gray-400">
                        {r.closed}
                        {r.excludedNominal > 0 ? (
                          <span className="text-gray-600" title="positions excluded as pre-fix nominal proceeds">
                            {' '}(-{r.excludedNominal})
                          </span>
                        ) : null}
                      </td>
                      <td className={`py-1 px-2 text-right ${r.medianPnlPct > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {pct(r.medianPnlPct)}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-400">{sol(r.medianSizeSol, 4)}</td>
                      <td className="py-1 px-2 text-right text-gray-400">{sol(r.grossSol, 3)}</td>
                      <td className="py-1 px-2 text-right text-amber-400">-{sol(r.dragSol, 3)}</td>
                      <td className={`py-1 px-2 text-right font-medium ${r.netPerTradeSol > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {sol(r.netPerTradeSol, 6)}
                      </td>
                      <td className="py-1 px-2 text-right text-gray-400">{r.peakConcurrent}</td>
                      {(() => {
                        const v = gateSample ? r.verdict : r.verdictUngated
                        return (
                          <td
                            className={`py-1 pl-2 ${
                              v === 'candidate'
                                ? 'text-emerald-400'
                                : v === 'marginal'
                                  ? 'text-amber-400'
                                  : v === 'insufficient'
                                    ? 'text-gray-500 italic'
                                    : 'text-gray-500'
                            }`}
                          >
                            {v}
                            {gateSample && r.verdict === 'insufficient' ? (
                              <span className="text-gray-600"> (n={r.closed})</span>
                            ) : null}
                          </td>
                        )
                      })()}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-gray-500 mt-1.5 leading-relaxed">
              Net/trade = (Σ pnl − calibrated drag) / closed, using the same cost model the desk charges.
              Peak open is simultaneous positions — at the live size it has to fit MAX_SOL_AT_RISK. A
              candidate has a positive typical trade <em>and</em> a total that survives the drag; below
              that it is not a sizing question.
            </p>
          </section>
        ) : null}

        {/* Ledger: realized PnL from recorded cash flows, not from the outcome percentage */}
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Ledger (real cash flows)</h2>
            <span className="text-xs text-gray-500">
              {ledger?.records ?? 0} sim records · derived read-side, not stored
            </span>
          </div>
          {ledger?.summary ? (
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat
                label="Realized PnL"
                value={`${sol(ledger.summary.realizedPnlSol)} SOL`}
                sub={`${pct(ledger.summary.realizedPnlPct)} on ${sol(ledger.summary.costSol, 3)} deployed`}
                tone={tone(ledger.summary.realizedPnlSol)}
              />
              <Stat
                label="Closed / open"
                value={`${ledger.summary.closed} / ${ledger.summary.open}`}
                sub={`${ledger.summary.won}W ${ledger.summary.lost}L · ${pct(ledger.summary.winRatePct, 1)} WR`}
              />
              <Stat
                label="Profit factor"
                value={ledger.summary.profitFactor != null ? ledger.summary.profitFactor.toFixed(2) : '—'}
                sub={`+${sol(ledger.summary.grossWinSol)} / ${sol(ledger.summary.grossLossSol)} SOL`}
                tone={(ledger.summary.profitFactor ?? 0) >= 1 ? 'text-emerald-400' : 'text-red-400'}
              />
              <Stat
                label="After modelled impact"
                value={`${sol(ledger.summary.realizedNetSol)} SOL`}
                sub={`−${sol(ledger.summary.modelledDragSol, 4)} SOL of modelled slippage, impact, fees and priority cost`}
                tone={tone(ledger.summary.realizedNetSol)}
              />
            </div>
          ) : (
            <p className="text-xs text-gray-500 mt-2">No ledger data for this range.</p>
          )}
          {(ledger?.strategies ?? []).length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-1.5 pr-4">Strategy</th>
                    <th className="py-1.5 pr-4">Closed</th>
                    <th className="py-1.5 pr-4">W / L</th>
                    <th className="py-1.5 pr-4">WR</th>
                    <th className="py-1.5 pr-4">Deployed</th>
                    <th className="py-1.5 pr-4">Realized SOL</th>
                    <th className="py-1.5 pr-4">Net (modelled)</th>
                    <th className="py-1.5">PF</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledger?.strategies ?? []).map((s) => (
                    <tr key={s.strategyId} className="border-b border-gray-800/50">
                      <td className="py-1.5 pr-4 text-gray-300">{s.strategyId}</td>
                      <td className="py-1.5 pr-4 text-gray-300">{s.closed}</td>
                      <td className="py-1.5 pr-4 text-gray-300">{s.won} / {s.lost}</td>
                      <td className="py-1.5 pr-4 text-gray-300">{pct(s.winRatePct, 0)}</td>
                      <td className="py-1.5 pr-4 text-gray-400">{sol(s.costSol, 3)}</td>
                      <td className={`py-1.5 pr-4 ${tone(s.realizedPnlSol)}`}>{sol(s.realizedPnlSol)}</td>
                      <td className={`py-1.5 pr-4 ${tone(s.realizedNetSol)}`}>{sol(s.realizedNetSol)}</td>
                      <td className="py-1.5 text-gray-400">{s.profitFactor != null ? s.profitFactor.toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="text-xs text-gray-500 mt-3">
            Derived from <code>trading_records</code>: each position is reconstructed from its own
            simulated buys and sells, scoped per strategy, with a full close ending the cycle. This is
            the ground truth the outcome percentage does not carry — no modelled slippage applied yet,
            so treat it as the &quot;before impact&quot; figure.
          </p>
        </section>

        {/* Open positions, from the SL/TP tracker the sims register into */}
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-baseline justify-between">
            <button
              onClick={() => setShowOpen((v) => !v)}
              className="font-semibold text-left hover:text-emerald-300"
            >
              {showOpen ? '▾' : '▸'} Open positions
            </button>
            <span className="text-xs text-gray-500">
              {openPositions.length} tracked ·{' '}
              {sol(openPositions.reduce((s, p) => s + Number(p.position_size || 0), 0), 4)} SOL at risk
            </span>
          </div>
          {showOpen ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-800">
                  <th className="py-1.5 pr-4">Token</th>
                  <th className="py-1.5 pr-4">Strategy</th>
                  <th className="py-1.5 pr-4">Size</th>
                  <th className="py-1.5 pr-4">Entry</th>
                  <th className="py-1.5 pr-4">Now</th>
                  <th className="py-1.5 pr-4">To stop</th>
                  <th className="py-1.5 pr-4">To target</th>
                  <th className="py-1.5">Opened</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((p) => {
                  const entry = Number(p.entry_price) || 0
                  const now = Number(p.current_price) || entry
                  const toStop = entry > 0 ? ((Number(p.stop_loss_price) - now) / now) * 100 : 0
                  const toTarget = entry > 0 ? ((Number(p.take_profit_price) - now) / now) * 100 : 0
                  return (
                    <tr key={`${p.token_address}-${p.strategy_id}`} className="border-b border-gray-800/50">
                      <td className="py-1.5 pr-4 text-gray-300">{p.token_symbol || p.token_address.slice(0, 6)}</td>
                      <td className="py-1.5 pr-4 text-gray-500">{p.strategy_id ?? '—'}</td>
                      <td className="py-1.5 pr-4 text-gray-300">{sol(Number(p.position_size), 4)}</td>
                      <td className="py-1.5 pr-4 text-gray-400">{entry.toPrecision(4)}</td>
                      <td className="py-1.5 pr-4 text-gray-400">{now.toPrecision(4)}</td>
                      <td className="py-1.5 pr-4 text-red-400">{toStop.toFixed(1)}%</td>
                      <td className="py-1.5 pr-4 text-emerald-400">{toTarget.toFixed(1)}%</td>
                      <td className="py-1.5 text-gray-500">{(p.created_at ?? '').slice(0, 16).replace('T', ' ')}</td>
                    </tr>
                  )
                })}
                {openPositions.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-3 text-gray-500">Nothing open right now.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          ) : null}
          <p className="text-xs text-gray-500 mt-3">
            Paper positions registered by the strategies with their own stop and target. The monitor
            evaluates them every cycle and records triggers — it never executes on-chain for a
            simulated position.
          </p>
        </section>

        {/* Closed positions, from the ledger reconstruction */}
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-baseline justify-between">
            <button
              onClick={() => setShowClosed((v) => !v)}
              className="font-semibold text-left hover:text-emerald-300"
            >
              {showClosed ? '▾' : '▸'} Closed positions
            </button>
            <span className="text-xs text-gray-500">
              {(ledger?.recentClosed ?? []).length} most recent · realized SOL per position
            </span>
          </div>
          {showClosed ? (
            <div className="mt-3 max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-800">
                    <th className="py-1.5 pr-4">Token</th>
                    <th className="py-1.5 pr-4">Strategy</th>
                    <th className="py-1.5 pr-4">Cost</th>
                    <th className="py-1.5 pr-4">Proceeds</th>
                    <th className="py-1.5 pr-4">PnL SOL</th>
                    <th className="py-1.5 pr-4">PnL %</th>
                    <th className="py-1.5">Closed</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledger?.recentClosed ?? []).map((p, i) => (
                    <tr key={`${p.mintAddress}-${p.strategyId}-${i}`} className="border-b border-gray-800/50">
                      <td className="py-1.5 pr-4 text-gray-300">{p.symbol || p.mintAddress.slice(0, 6)}</td>
                      <td className="py-1.5 pr-4 text-gray-500">{p.strategyId ?? '—'}</td>
                      <td className="py-1.5 pr-4 text-gray-400">{sol(p.costSol, 4)}</td>
                      <td className="py-1.5 pr-4 text-gray-400">{sol(p.proceedsSol, 4)}</td>
                      <td className={`py-1.5 pr-4 ${tone(p.pnlSol)}`}>{sol(p.pnlSol, 5)}</td>
                      <td className={`py-1.5 pr-4 ${tone(p.pnlPct)}`}>{pct(p.pnlPct, 1)}</td>
                      <td className="py-1.5 text-gray-500">
                        {p.closedAt ? new Date(p.closedAt).toISOString().slice(0, 16).replace('T', ' ') : '—'}
                      </td>
                    </tr>
                  ))}
                  {(ledger?.recentClosed ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-3 text-gray-500">Nothing closed in this range.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="text-xs text-gray-500 mt-3">
            Reconstructed read-side from <code>trading_records</code> — each position from its own
            simulated buys and sells, scoped per strategy. Positions closed before the exit-valuation
            fix still carry nominal sell amounts, so the mcap family&apos;s history here is distorted.
          </p>
        </section>

        {/* Regime context — populated once market_regime_tags has rows */}
        <section className="rounded border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">PnL by regime</h2>
            <span className="text-xs text-gray-500">
              {regimes.filter((r) => r.regimeTag).length} tag(s) with data
            </span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-800">
                  <th className="py-1.5 pr-4">Regime</th>
                  <th className="py-1.5 pr-4">Trades</th>
                  <th className="py-1.5 pr-4">W / L</th>
                  <th className="py-1.5 pr-4">PnL %</th>
                  <th className="py-1.5">PnL SOL (flat)</th>
                </tr>
              </thead>
              <tbody>
                {regimes.map((r) => (
                  <tr key={r.regimeTag ?? '(untagged)'} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-4 text-gray-300">
                      {r.regimeTag ?? <span className="text-gray-500">(untagged)</span>}
                    </td>
                    <td className="py-1.5 pr-4 text-gray-300">{r.trades}</td>
                    <td className="py-1.5 pr-4 text-gray-300">
                      {r.won} / {r.lost}
                    </td>
                    <td className={`py-1.5 pr-4 ${tone(r.sumPnlPct)}`}>{pct(r.sumPnlPct, 0)}</td>
                    <td className={`py-1.5 ${tone(r.pnlSolFlat)}`}>{sol(r.pnlSolFlat)}</td>
                  </tr>
                ))}
                {regimes.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-3 text-gray-500">
                      No regime tags yet for this range.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            The brain&apos;s climate is now persisted daily into <code>market_regime_tags</code>, and
            outcomes are stamped with the day&apos;s tag at insert, so this table fills in as new
            closes land. Tags before that are absent — the table had no rows since 2026-07-10.
          </p>
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
                  <th className="py-1.5 pr-4">WR</th>
                  <th className="py-1.5 pr-4">Avg risk</th>
                  <th className="py-1.5 pr-4">R:R</th>
                  <th className="py-1.5 pr-4">PF</th>
                  <th className="py-1.5 pr-4">Open</th>
                  <th className="py-1.5 pr-4">Velocity</th>
                  <th className="py-1.5 pr-4">Budget</th>
                  <th className="py-1.5">Optimal</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.day} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-4 text-gray-300">{r.day}</td>
                    <td className="py-1.5 pr-4 text-gray-300">
                      <button
                        onClick={() => void toggleDay(r.day)}
                        className="text-left hover:text-emerald-300"
                        title="Show the tokens traded that day"
                      >
                        {expanded === r.day ? '▾' : '▸'} {r.trades}
                      </button>
                    </td>
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
                    <td className={`py-1.5 pr-4 ${r.winRatePct >= 50 ? 'text-emerald-400' : 'text-gray-300'}`}>
                      {pct(r.winRatePct, 0)}
                    </td>
                    <td className="py-1.5 pr-4 text-gray-400">{sol(r.avgRiskSol, 4)}</td>
                    <td className="py-1.5 pr-4 text-gray-400">
                      {r.winLossRatio != null ? `${r.winLossRatio.toFixed(2)}×` : '—'}
                    </td>
                    <td className={`py-1.5 pr-4 ${(r.profitFactor ?? 0) >= 1 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {r.profitFactor != null ? r.profitFactor.toFixed(2) : '—'}
                    </td>
                    <td className="py-1.5 pr-4 text-gray-300">{r.peakConcurrent}</td>
                    <td className="py-1.5 pr-4 text-gray-300">{sol(r.velocityMaxSol, 3)}</td>
                    <td className={`py-1.5 pr-4 ${r.budgetUsedPct > 100 ? 'text-amber-400' : 'text-gray-300'}`}>
                      {pct(r.budgetUsedPct, 0)}
                    </td>
                    <td className="py-1.5 text-gray-400">{sol(r.optimalBudgetSol, 3)}</td>
                    {expanded === r.day ? (
                      <tr className="bg-gray-950/60">
                        <td colSpan={15} className="px-4 py-3">
                          {dayLoading === r.day ? (
                            <span className="text-gray-500 text-xs">Loading {r.day}…</span>
                          ) : (dayTrades[r.day] ?? []).length === 0 ? (
                            <span className="text-gray-500 text-xs">No closed trades on {r.day}.</span>
                          ) : (
                            <div className="max-h-80 overflow-y-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-gray-500 text-left border-b border-gray-800">
                                    <th className="py-1 pr-3">Token</th>
                                    <th className="py-1 pr-3">Strategy</th>
                                    <th className="py-1 pr-3">PnL %</th>
                                    <th className="py-1 pr-3">Status</th>
                                    <th className="py-1 pr-3">Regime</th>
                                    <th className="py-1 pr-3">Exit</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(dayTrades[r.day] ?? []).map((t, i) => (
                                    <tr key={`${t.token_address}-${i}`} className="border-b border-gray-800/40">
                                      <td className="py-1 pr-3 text-gray-300">
                                        {t.token_symbol || t.token_address.slice(0, 6)}
                                        {t.has_exec ? <span className="text-emerald-500"> ✓exec</span> : null}
                                      </td>
                                      <td className="py-1 pr-3 text-gray-500">{t.strategy_id}</td>
                                      <td className={`py-1 pr-3 ${tone(Number(t.pnl_pct ?? 0))}`}>
                                        {pct(Number(t.pnl_pct ?? 0), 1)}
                                      </td>
                                      <td className="py-1 pr-3 text-gray-400">{t.status ?? '—'}</td>
                                      <td className="py-1 pr-3 text-gray-500">{t.regime_tag ?? '—'}</td>
                                      <td className="py-1 pr-3 text-gray-500">
                                        {(t.exit_at ?? '').slice(11, 16)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>

                    ) : null}
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-3 text-gray-500">
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
