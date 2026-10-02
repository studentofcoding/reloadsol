'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CalibrationOverrides,
  CalibrationRun,
  CalibrationRunRow,
} from '@/strategies/rug-signal-calibration'
import type { Bucket, SeparationReport, SweepPoint } from '@/strategies/rug-signal-separation'
import RugSignalChart, {
  type RugChartBar,
  type RugChartMarker,
  type RugChartLabel,
} from '@/components/signals/RugSignalChart'

/**
 * Rug signal — reachability and soak, for the dev page.
 *
 * The replay runs server-side with the **real** scorer (a browser cannot import it, and a copy would
 * be a different program from the thing being calibrated), so this panel only proposes anchors and
 * renders what comes back. Nothing here writes a verdict: the only persistence is a calibration run.
 *
 * The anchor inputs are prefilled with the settings the run actually used, and the preset button
 * applies the P1 hypothesis — drop the dispersion term the series cannot inform — so the change can
 * be measured against the current numbers before anyone adopts it.
 */

type ShadowEntry = {
  id: string
  createdAt: string
  tokenAddress: string
  score: number | null
  decision: string
  barsSource: string
  barsUsed: number
  barsScored: number
  reason: string | null
  breakdown: Record<string, number> | null
  source: string
}

type ShadowSummary = { rows: number; byDecision: Record<string, number>; newest: string | null }

const ANCHOR_LABELS: Array<{ key: keyof CalibrationOverrides; label: string; hint: string }> = [
  { key: 'threshold', label: 'threshold', hint: 'trip score (operator rule: 80)' },
  { key: 'coreThreshold', label: 'coreThreshold', hint: 'staircase+liquidity trip (0 disables)' },
  { key: 'volExpansionWeight', label: 'volExpansionWeight', hint: '1 = drop the inert dispersion term' },
  { key: 'volCvSafe', label: 'volCvSafe', hint: 'volume CV anchor' },
  { key: 'liqSafeRatio', label: 'liqSafeRatio', hint: 'liq/mcap read as deep' },
  { key: 'stairBullishMin', label: 'stairBullishMin', hint: 'green-bar share' },
  { key: 'stairAvgGainMax', label: 'stairAvgGainMax', hint: 'mean green gain cap' },
  { key: 'stairPriceGainMin', label: 'stairPriceGainMin', hint: 'window gain floor' },
  { key: 'stairWickVarMax', label: 'stairWickVarMax', hint: 'wick variance cap' },
]

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`
}

function num(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(digits)
}

type CellLike = { n: number; hits: number; rate: number | null; ci: { lo: number; hi: number } | null }

/**
 * A rate without its interval is a claim, not a measurement — and a rate on too few samples is not a
 * rate at all. Both are shown rather than dressed up.
 */
function CellText({ cell }: { cell: CellLike }) {
  if (cell.n === 0 || cell.rate == null || cell.ci == null) {
    return <span className="text-gray-500">n/a (no rows)</span>
  }
  return (
    <span className={cell.n >= 5 ? 'text-white' : 'text-gray-400'}>
      {pct(cell.rate)}{' '}
      <span className="text-gray-500">
        [{pct(cell.ci.lo)}, {pct(cell.ci.hi)}] ({cell.hits}/{cell.n})
      </span>
      {cell.n < 5 ? <span className="ml-2 text-[10px] text-amber-400">inconclusive, n&lt;5</span> : null}
    </span>
  )
}

function BucketTable({ buckets }: { buckets: Bucket[] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {buckets.map((b) => (
          <tr key={b.label} className="border-t border-gray-800">
            <td className="w-24 px-2 py-1 text-gray-400">{b.label}</td>
            <td className="px-2 py-1">
              <CellText cell={b} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SweepTable({ points, unit }: { points: SweepPoint[]; unit: string }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {points.map((p) => (
          <tr key={p.candidate} className="border-t border-gray-800">
            <td className="w-28 px-2 py-1 text-gray-400">
              {unit} {p.candidate}
            </td>
            <td className="px-2 py-1">
              {p.n === 0 ? <span className="text-gray-500">no trips</span> : <CellText cell={p} />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function RugSignalPanel() {
  const [run, setRun] = useState<CalibrationRun | null>(null)
  const [runs, setRuns] = useState<CalibrationRunRow[]>([])
  const [entries, setEntries] = useState<ShadowEntry[]>([])
  const [summary, setSummary] = useState<ShadowSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [anchorText, setAnchorText] = useState<Record<string, string>>({})
  const [separation, setSeparation] = useState<SeparationReport | null>(null)
  const [sepDays, setSepDays] = useState(4)
  const [sepBusy, setSepBusy] = useState(false)
  const [mint, setMint] = useState('')
  const [tokenBars, setTokenBars] = useState<RugChartBar[]>([])
  const [tokenMarkers, setTokenMarkers] = useState<RugChartMarker[]>([])
  const [tokenLabel, setTokenLabel] = useState<RugChartLabel | null>(null)
  const [mintBusy, setMintBusy] = useState(false)
  const [labelBusy, setLabelBusy] = useState(false)
  const [labelNote, setLabelNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [shadowRes, runsRes] = await Promise.all([
        fetch('/api/rug-signal/shadow?limit=40', { credentials: 'include' }),
        fetch('/api/rug-signal/calibration?limit=8', { credentials: 'include' }),
      ])
      const shadow = await shadowRes.json()
      const stored = await runsRes.json()
      if (shadow?.success) {
        setEntries(shadow.entries ?? [])
        setSummary(shadow.summary ?? null)
      }
      if (stored?.success) {
        setRuns(stored.runs ?? [])
        const latest = (stored.runs ?? [])[0]?.summary ?? null
        if (latest) setRun((prev) => prev ?? latest)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * The separation view asks a different question from the replay — is any *single* component doing
   * the work — and it costs a full window of rows plus their minutes, so it loads on its own.
   */
  const loadSeparation = useCallback(async (days: number) => {
    setSepBusy(true)
    try {
      const res = await fetch(`/api/rug-signal/separation?days=${days}`, { credentials: 'include' })
      const body = await res.json()
      if (!body?.success) throw new Error(body?.error ?? `HTTP ${res.status}`)
      setSeparation(body.report as SeparationReport)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'separation load failed')
    } finally {
      setSepBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadSeparation(sepDays)
  }, [loadSeparation, sepDays])

  /** One mint's evidence: the mcap minutes the scorer reads, plus every evaluation on them. */
  const loadToken = useCallback(async (address: string) => {
    const trimmed = address.trim()
    if (!trimmed) return
    setMintBusy(true)
    setLabelNote(null)
    try {
      const res = await fetch(
        `/api/rug-signal/token?address=${encodeURIComponent(trimmed)}&hours=24`,
        { credentials: 'include' },
      )
      const body = await res.json()
      if (!body?.success) throw new Error(body?.error ?? `HTTP ${res.status}`)
      setTokenBars((body.bars ?? []) as RugChartBar[])
      setTokenMarkers((body.markers ?? []) as RugChartMarker[])
      setTokenLabel(
        body.label
          ? {
              source: String(body.label.source),
              addedAt: Number.isFinite(Date.parse(body.label.addedAt))
                ? Math.floor(Date.parse(body.label.addedAt) / 1000)
                : 0,
            }
          : null,
      )
      setMint(trimmed)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'token load failed')
    } finally {
      setMintBusy(false)
    }
  }, [])

  /**
   * Applying the label goes through `POST /api/rug` like every other surface, with its own source so
   * a human label from this page is never mistaken for the automated `rug-signal` one — which also
   * means it is attributed to the dev rather than filed as machine output.
   */
  const writeLabel = useCallback(
    async (action: 'mark' | 'unmark') => {
      if (!mint) return
      setLabelBusy(true)
      setLabelNote(null)
      try {
        const res = await fetch('/api/rug', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenAddress: mint, source: 'rug-signal-dev', action }),
        })
        const body = await res.json()
        if (!res.ok || !body?.success) throw new Error(body?.error ?? `HTTP ${res.status}`)
        setLabelNote(action === 'mark' ? 'label applied' : 'label removed')
        await loadToken(mint)
      } catch (e) {
        setLabelNote(e instanceof Error ? e.message : 'label write failed')
      } finally {
        setLabelBusy(false)
      }
    },
    [mint, loadToken],
  )

  // Start on the newest observation so the page opens on something real rather than an empty chart.
  useEffect(() => {
    if (mint || entries.length === 0) return
    void loadToken(entries[0]!.tokenAddress)
  }, [entries, mint, loadToken])

  const replay = useCallback(
    async (overrides?: CalibrationOverrides) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/rug-signal/calibrate', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 1, overrides }),
        })
        const body = await res.json()
        if (!res.ok || !body?.success) throw new Error(body?.error ?? `HTTP ${res.status}`)
        setRun(body.run as CalibrationRun)
        setAnchorText({})
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'replay failed')
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const collected = useMemo(() => {
    const out: CalibrationOverrides = {}
    for (const { key } of ANCHOR_LABELS) {
      const raw = anchorText[key]
      if (raw == null || raw.trim() === '') continue
      const n = Number(raw)
      if (Number.isFinite(n)) out[key] = n
    }
    return out
  }, [anchorText])

  const binding = useMemo(() => {
    if (!run || run.components.length === 0) return null
    // The binding component is the one furthest below its own maximum — that is what holds the
    // ceiling down, and therefore what has to move.
    return [...run.components].sort(
      (a, b) => a.maxPoints / Math.max(a.maxOf, 1) - b.maxPoints / Math.max(b.maxOf, 1),
    )[0]
  }, [run])

  const card = 'rounded-lg border border-gray-700 bg-gray-900 p-4'
  const th = 'px-2 py-1 text-left text-xs uppercase tracking-wide text-gray-500'
  const td = 'px-2 py-1 text-gray-300'

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>
      )}

      {/* ---- reachability ---- */}
      <section className={card}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Reachability</h2>
          <button
            onClick={() => void replay()}
            disabled={busy}
            className="rounded bg-white px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
          >
            {busy ? 'Replaying…' : 'Replay current anchors'}
          </button>
        </div>

        {run ? (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              {[
                { k: 'sampled', v: run.sampled },
                { k: 'rescored', v: run.rescored },
                { k: 'trips', v: run.trips },
                { k: 'trip rate', v: pct(run.tripRate) },
                { k: 'best', v: run.best ? `${run.best.score}` : '—' },
              ].map((s) => (
                <div key={s.k}>
                  <div className="text-xs uppercase tracking-wide text-gray-500">{s.k}</div>
                  <div className="text-xl font-semibold text-white">{s.v}</div>
                </div>
              ))}
            </div>

            <p className="mt-3 text-sm text-gray-400">
              {binding ? (
                <>
                  Binding component: <span className="text-gray-200">{binding.id}</span> — reaches{' '}
                  <span className="text-gray-200">
                    {binding.maxPoints}/{binding.maxOf}
                  </span>{' '}
                  at best. The ceiling is the sum of what each component can reach, so this is what has to move
                  for a trip to be possible at all.
                </>
              ) : (
                'No components evaluated.'
              )}
            </p>
            <p className="mt-3 text-sm text-gray-400">
              core pair (staircase + liquidity): avg{' '}
              <span className="text-gray-200">{run.core.avg.toFixed(1)}</span> · max{' '}
              <span className="text-gray-200">{run.core.max}</span> · threshold{' '}
              <span className="text-gray-200">{run.effective.coreThreshold ?? '—'}</span>
              {run.tripsByPath && (
                <>
                  {' '}
                  — trips: <span className="text-gray-200">{run.tripsByPath.score}</span> by score,{' '}
                  <span className="text-gray-200">{run.tripsByPath.core}</span> by the shape pair
                </>
              )}
            </p>
            {run.crossCheckChecked > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                cross-check vs the shadow log: {run.crossCheckChecked} rows compared,{' '}
                <span className={run.crossCheckMismatches > 0 ? 'text-amber-400' : 'text-gray-400'}>
                  {run.crossCheckMismatches} mismatched
                </span>
                . A mismatch means the replay and the logged verdict disagree — one of them is wrong.
              </p>
            )}

            {/* score histogram, newest anchors */}
            <div className="mt-4">
              <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
                score distribution (trip at {run.effective.threshold ?? '—'})
              </div>
              <div className="space-y-0.5">
                {run.scoreHistogram.slice(0, 10).map((b) => (
                  <div key={b.score} className="flex items-center gap-2">
                    <span className="w-8 text-right text-xs text-gray-500">{b.score}</span>
                    <div
                      className={`h-3 rounded-sm ${b.score >= (run.effective.threshold ?? 80) ? 'bg-lime-500' : 'bg-gray-600'}`}
                      style={{ width: `${Math.max(2, (b.n / run.scoreHistogram[0]!.n) * 100)}%` }}
                    />
                    <span className="text-xs text-gray-500">{b.n}</span>
                  </div>
                ))}
                {run.scoreHistogram.length === 0 && <p className="text-sm text-gray-500">nothing scored</p>}
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400">
            No replay stored yet — run one to see the reachable ceiling with the current anchors.
          </p>
        )}
      </section>

      {/* ---- anchors + presets ---- */}
      <section className={card}>
        <h2 className="mb-1 text-lg font-semibold text-white">Anchors</h2>
        <p className="mb-3 text-sm text-gray-400">
          Overrides are whitelisted and clamped; blank means “use the current value”. The preset applies the P1
          hypothesis — the volume band stops averaging in a dispersion term our series cannot inform — and the
          replay shows what that does to the trip rate.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {ANCHOR_LABELS.map((a) => (
            <label key={a.key} className="block">
              <span className="block text-xs text-gray-400">{a.label}</span>
              <input
                value={anchorText[a.key] ?? ''}
                onChange={(e) => setAnchorText((prev) => ({ ...prev, [a.key]: e.target.value }))}
                placeholder={
                  run?.effective?.[a.key] != null ? String(run.effective[a.key]) : 'current'
                }
                className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-white placeholder:text-gray-600"
              />
              <span className="mt-0.5 block text-[10px] text-gray-600">{a.hint}</span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => void replay(collected)}
            disabled={busy}
            className="rounded bg-white px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
          >
            Run replay with overrides
          </button>
          <button
            onClick={() => {
              setAnchorText({ volExpansionWeight: '1' })
              void replay({ volExpansionWeight: 1 })
            }}
            disabled={busy}
            className="rounded border border-lime-600 px-3 py-1.5 text-sm font-semibold text-lime-400 disabled:opacity-50"
          >
            Preset: drop the inert dispersion term (volExpansionWeight = 1)
          </button>
        </div>
      </section>

      {/* ---- separation ---- */}
      <section className={card}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-white">
            Separation — which component is actually carrying the trip?
          </h2>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <label>
              days{' '}
              <input
                type="number"
                min={1}
                max={30}
                value={sepDays}
                onChange={(e) =>
                  setSepDays(Math.max(1, Math.min(30, Number(e.target.value) || sepDays)))
                }
                className="w-14 rounded border border-gray-700 bg-gray-950 px-2 py-0.5 text-gray-200"
              />
            </label>
            <button
              type="button"
              onClick={() => void loadSeparation(sepDays)}
              disabled={sepBusy}
              className="rounded border border-gray-600 px-2 py-0.5 text-gray-300 disabled:opacity-50"
            >
              {sepBusy ? 'loading…' : 'reload'}
            </button>
          </div>
        </div>
        <p className="mb-3 max-w-4xl text-xs text-gray-500">
          The sum hides which term is doing the work, so each component is shown alone. Rates are{' '}
          <span className="text-gray-300">per distinct mint</span> — the same mint is re-evaluated every
          sweep, so a per-row count flatters every bucket. Below 5 samples a rate is not a result.
        </p>

        {separation ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span
                className={
                  separation.verdict.state === 'lift'
                    ? 'rounded border border-lime-700 bg-lime-950/40 px-2 py-0.5 text-lime-300'
                    : separation.verdict.state === 'no_lift'
                      ? 'rounded border border-red-800 bg-red-950/40 px-2 py-0.5 text-red-300'
                      : 'rounded border border-amber-700 bg-amber-950/40 px-2 py-0.5 text-amber-300'
                }
              >
                {separation.verdict.state}
              </span>
              <span className="text-gray-300">{separation.verdict.text}</span>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
              <span>shadow rows {separation.rows.shadow}</span>
              <span>judged {separation.rows.judged}</span>
              <span>labelled {separation.rows.labelled}</span>
              <span>unlabellable {separation.rows.unlabellable}</span>
              <span>distinct mints {separation.rows.mints}</span>
              <span className="text-gray-400">
                collapses {separation.rows.collapses} · base rate {pct(separation.rows.baseRate)}
                {separation.rows.baseCi
                  ? ` [${pct(separation.rows.baseCi.lo)}, ${pct(separation.rows.baseCi.hi)}]`
                  : ''}
              </span>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
                  staircase points → collapse
                </div>
                <BucketTable buckets={separation.staircase} />
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
                  liquidity / mcap → collapse
                </div>
                <BucketTable buckets={separation.liquidity} />
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
                  staircase threshold sweep
                </div>
                <SweepTable points={separation.staircaseSweep} unit="staircase ≥" />
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
                  shipped core rule (staircase + liquidity) sweep
                </div>
                <SweepTable points={separation.coreSweep} unit="core ≥" />
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
                  liquidity-only sweep
                </div>
                <SweepTable points={separation.liquiditySweep} unit="liq/mcap ≤" />
              </div>
              <div>
                <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
                  per-day agreement (the acceptance rule)
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {separation.perDay.map((d) => (
                      <tr key={d.day} className="border-t border-gray-800">
                        <td className="px-2 py-1 font-mono text-xs text-gray-400">{d.day}</td>
                        <td className="px-2 py-1 text-xs text-gray-500">
                          rows {d.rows} · collapses {d.collapses}
                        </td>
                        <td className="px-2 py-1">
                          <CellText
                            cell={{
                              n: d.staircaseTrips,
                              hits: d.staircaseCollapses,
                              rate: d.staircaseTrips > 0 ? d.staircaseCollapses / d.staircaseTrips : null,
                              ci:
                                d.staircaseTrips > 0
                                  ? {
                                      lo: Math.max(0, d.staircaseCollapses / d.staircaseTrips - 0.25),
                                      hi: Math.min(1, d.staircaseCollapses / d.staircaseTrips + 0.25),
                                    }
                                  : null,
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                    {separation.perDay.length === 0 && (
                      <tr>
                        <td className="px-2 py-1 text-gray-500">nothing labelled yet</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <p className="mt-1 text-[10px] text-gray-500">
                  interval shown is an approximation across days; the pooled interval above is exact.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">{sepBusy ? 'loading…' : 'no separation report yet'}</p>
        )}
      </section>

      {/* ---- components + conditions ---- */}
      {run && run.components.length > 0 && (
        <section className={card}>
          <h2 className="mb-3 text-lg font-semibold text-white">Components &amp; sub-conditions</h2>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>component</th>
                <th className={th}>avg pts</th>
                <th className={th}>max pts</th>
                <th className={th}>of</th>
                <th className={th}>reach</th>
              </tr>
            </thead>
            <tbody>
              {run.components.map((c) => (
                <tr key={c.id} className="border-t border-gray-800">
                  <td className={td}>{c.id}</td>
                  <td className={td}>{c.avgPoints.toFixed(1)}</td>
                  <td className={`${td} text-white`}>{c.maxPoints}</td>
                  <td className={td}>{c.maxOf}</td>
                  <td className={td}>{pct(c.maxPoints / Math.max(c.maxOf, 1))}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">condition met-rate</div>
              {run.conditions.map((c) => (
                <div key={c.id} className="py-1">
                  <div className="flex items-center gap-2">
                    <span className="w-32 text-xs text-gray-400">{c.id}</span>
                    <div className="h-3 flex-1 rounded-sm bg-gray-800">
                      <div
                        className={`h-3 rounded-sm ${c.metRate && c.metRate > 0 ? 'bg-lime-600' : 'bg-gray-700'}`}
                        style={{ width: `${Math.max(1, (c.metRate ?? 0) * 100)}%` }}
                      />
                    </div>
                    <span className="w-12 text-right text-xs text-gray-500">{pct(c.metRate)}</span>
                  </div>
                  <div className="flex gap-3 pl-[8.5rem] text-[10px] text-gray-500">
                    <span>p10 {num(c.p10)}</span>
                    <span>p50 {num(c.p50)}</span>
                    <span>p90 {num(c.p90)}</span>
                    <span className="text-gray-400">threshold {num(c.threshold)}</span>
                  </div>
                </div>
              ))}
              {run.conditions.length === 0 && <p className="text-sm text-gray-500">none evaluated</p>}
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-gray-500">
                raw measure distribution (p10 / p50 / p90)
              </div>
              {run.measures.map((m) => (
                <div key={m.id} className="flex justify-between py-0.5 text-xs">
                  <span className="text-gray-400">{m.id}</span>
                  <span className="font-mono text-gray-300">
                    {num(m.p10)} · {num(m.p50)} · {num(m.p90)}
                  </span>
                </div>
              ))}
              {run.measures.length === 0 && <p className="text-sm text-gray-500">none evaluated</p>}
            </div>
          </div>
        </section>
      )}

      {/* ---- stored runs ---- */}
      <section className={card}>
        <h2 className="mb-3 text-lg font-semibold text-white">Replay history</h2>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={th}>when</th>
              <th className={th}>changed</th>
              <th className={th}>rescored</th>
              <th className={th}>trips</th>
              <th className={th}>trip rate</th>
              <th className={th}>best</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-gray-800">
                <td className={`${td} font-mono text-xs`}>{r.createdAt.slice(0, 19)}</td>
                <td className={`${td} font-mono text-xs`}>
                  {Object.entries(r.overrides ?? {}).length === 0
                    ? '— (current)'
                    : Object.entries(r.overrides)
                        .map(([k, v]) => `${k}=${v}`)
                        .join('  ')}
                </td>
                <td className={td}>{r.summary?.rescored ?? '—'}</td>
                <td className={td}>{r.summary?.trips ?? '—'}</td>
                <td className={`${td} text-white`}>{pct(r.summary?.tripRate)}</td>
                <td className={td}>{r.summary?.best?.score ?? '—'}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className={`${td} text-gray-500`} colSpan={6}>
                  no runs yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* ---- the evidence, drawn ---- */}
      <section className={card}>
        <h2 className="mb-1 text-lg font-semibold text-white">
          The evidence — mcap minutes and every verdict on them
        </h2>
        <p className="mb-3 max-w-4xl text-xs text-gray-500">
          The same series the scorer reads, with each evaluation marked on the bar it was reached from —
          so a verdict can be checked against what produced it instead of taken on faith. Click a mint in
          the soak table to load it. Applying the label writes to the rug registry under{' '}
          <span className="text-gray-300">rug-signal-dev</span>, which keeps a human label distinct from
          the automated <span className="text-gray-300">rug-signal</span> one.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={mint}
            onChange={(e) => setMint(e.target.value)}
            placeholder="mint address"
            className="w-[24rem] rounded border border-gray-700 bg-gray-950 px-2 py-1 font-mono text-xs text-gray-200"
          />
          <button
            type="button"
            onClick={() => void loadToken(mint)}
            disabled={mintBusy || mint.trim() === ''}
            className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 disabled:opacity-50"
          >
            {mintBusy ? 'loading…' : 'load'}
          </button>
          <button
            type="button"
            onClick={() => void writeLabel('mark')}
            disabled={labelBusy || mint.trim() === '' || tokenLabel != null}
            className="rounded border border-red-700 px-2 py-1 text-xs font-semibold text-red-300 disabled:opacity-50"
          >
            mark as rug
          </button>
          <button
            type="button"
            onClick={() => void writeLabel('unmark')}
            disabled={labelBusy || tokenLabel == null}
            className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 disabled:opacity-50"
          >
            unmark
          </button>
          {tokenLabel ? (
            <span className="text-xs text-amber-400">labelled · {tokenLabel.source}</span>
          ) : (
            <span className="text-xs text-gray-500">not labelled</span>
          )}
          {labelNote ? <span className="text-xs text-gray-400">{labelNote}</span> : null}
        </div>
        <RugSignalChart bars={tokenBars} markers={tokenMarkers} label={tokenLabel} />
      </section>

      {/* ---- the soak ---- */}
      <section className={card}>
        <h2 className="mb-1 text-lg font-semibold text-white">The soak</h2>
        <p className="mb-3 text-sm text-gray-400">
          {summary
            ? `${summary.rows} rows · ${Object.entries(summary.byDecision)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')}`
            : 'loading…'}
          {summary?.newest ? ` · newest ${summary.newest.slice(0, 19)}` : ''}
        </p>
        <p className="mb-3 text-xs text-gray-500">
          Only <span className="text-gray-300">pass</span> and{' '}
          <span className="text-gray-300">would_rug</span> are judged verdicts;{' '}
          <span className="text-gray-300">no_bars</span> means the scorer had too few bars to judge — an
          unknown, never counted as a negative.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={th}>when</th>
              <th className={th}>mint</th>
              <th className={th}>score</th>
              <th className={th}>decision</th>
              <th className={th}>bars</th>
              <th className={th}>breakdown</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 25).map((e) => (
              <tr key={e.id} className="border-t border-gray-800">
                <td className={`${td} font-mono text-xs`}>{e.createdAt.slice(11, 19)}</td>
                <td className={`${td} font-mono text-xs`}>
                  <button
                    type="button"
                    onClick={() => void loadToken(e.tokenAddress)}
                    title="load this mint in the chart below"
                    className="text-gray-300 underline decoration-dotted hover:text-white"
                  >
                    {e.tokenAddress.slice(0, 8)}…
                  </button>
                </td>
                <td className={`${td} ${e.score != null && e.score >= 80 ? 'text-lime-400' : 'text-white'}`}>
                  {e.score ?? '—'}
                </td>
                <td className={td}>{e.decision}</td>
                <td className={`${td} text-xs`}>
                  {e.barsScored}/{e.barsUsed}
                </td>
                <td className={`${td} font-mono text-xs`}>
                  {e.breakdown
                    ? `S${e.breakdown.staircase ?? 0} V${e.breakdown.volume ?? 0} L${e.breakdown.liquidity ?? 0} D${e.breakdown.dump ?? 0}`
                    : '—'}
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td className={`${td} text-gray-500`} colSpan={6}>
                  no shadow rows in range
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}
