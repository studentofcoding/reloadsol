'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CalibrationOverrides,
  CalibrationRun,
  CalibrationRunRow,
} from '@/strategies/rug-signal-calibration'

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

export default function RugSignalPanel() {
  const [run, setRun] = useState<CalibrationRun | null>(null)
  const [runs, setRuns] = useState<CalibrationRunRow[]>([])
  const [entries, setEntries] = useState<ShadowEntry[]>([])
  const [summary, setSummary] = useState<ShadowSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [anchorText, setAnchorText] = useState<Record<string, string>>({})

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
                <div key={c.id} className="flex items-center gap-2 py-0.5">
                  <span className="w-32 text-xs text-gray-400">{c.id}</span>
                  <div className="h-3 flex-1 rounded-sm bg-gray-800">
                    <div
                      className={`h-3 rounded-sm ${c.metRate && c.metRate > 0 ? 'bg-lime-600' : 'bg-gray-700'}`}
                      style={{ width: `${Math.max(1, (c.metRate ?? 0) * 100)}%` }}
                    />
                  </div>
                  <span className="w-12 text-right text-xs text-gray-500">{pct(c.metRate)}</span>
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
                <td className={`${td} font-mono text-xs`}>{e.tokenAddress.slice(0, 8)}…</td>
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
