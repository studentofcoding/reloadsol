'use client'

import { useCallback, useEffect, useState } from 'react'

type LastRun = {
  runId?: string
  mode?: string
  scanned?: number
  skipped?: number
  paperOpened?: number
  liveAttempted?: number
  predictCount?: number
  linkedCount?: number
  errors?: number
  finishedAt?: string
  enabled?: boolean
  shadow?: boolean
}

type StatusApi = {
  success: boolean
  enabled?: boolean
  shadow?: boolean
  mode?: 'paper' | 'live'
  liveTradeEnabled?: boolean
  lastRun?: LastRun | null
  error?: string
}

type RunAccuracy = {
  runId: string
  startedAt?: string | null
  finishedAt?: string | null
  candidateCount: number
  predictCount: number
  linkedCount: number
  resolved: number
  correct: number
  accuracy: number | null
  avgPredictedScoreWins: number | null
  avgPredictedScoreLosses: number | null
  shadow?: boolean
  mode?: string | null
}

type RunPrediction = {
  id: string
  runId: string
  predictedAt: string
  mint: string
  strategyId: string
  predictedLabel: 'win' | 'loss'
  predictedScore: number | null
  modelVersion: string | null
  actualLabel: 'win' | 'loss' | null
  correct: boolean | null
}

type ReportApi = {
  success: boolean
  runs?: RunAccuracy[]
  run?: RunAccuracy | null
  predictions?: RunPrediction[]
  error?: string
}

type Props = {
  onNotify?: (kind: 'success' | 'error', title: string, detail?: string) => void
}

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function score(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(2)
}

export default function EvalEnginePanel({ onNotify }: Props) {
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [data, setData] = useState<StatusApi | null>(null)
  const [runs, setRuns] = useState<RunAccuracy[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [predictions, setPredictions] = useState<RunPrediction[]>([])
  const [loadingPreds, setLoadingPreds] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [statusRes, reportRes] = await Promise.all([
        fetch('/api/strategies/ml/eval-scan'),
        fetch('/api/strategies/ml/eval-report?days=7'),
      ])
      const json = (await statusRes.json()) as StatusApi
      if (!json.success) throw new Error(json.error ?? 'load failed')
      setData(json)
      const report = (await reportRes.json()) as ReportApi
      if (report.success && Array.isArray(report.runs)) {
        setRuns(report.runs)
      }
    } catch (e) {
      onNotify?.(
        'error',
        'Eval engine status failed',
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

  const loadRun = async (runId: string) => {
    setSelectedRunId(runId)
    setLoadingPreds(true)
    try {
      const res = await fetch(`/api/strategies/ml/eval-report?run_id=${encodeURIComponent(runId)}`)
      const json = (await res.json()) as ReportApi
      if (!json.success) throw new Error(json.error ?? 'run load failed')
      setPredictions(json.predictions ?? [])
    } catch (e) {
      onNotify?.(
        'error',
        'Eval run failed',
        e instanceof Error ? e.message : String(e),
      )
    } finally {
      setLoadingPreds(false)
    }
  }

  const runScan = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/strategies/ml/eval-scan', {
        method: 'POST',
        credentials: 'include',
      })
      const json = (await res.json()) as {
        success?: boolean
        error?: string
        paperOpened?: number
        scanned?: number
        predictCount?: number
        shadow?: boolean
      }
      if (!json.success) throw new Error(json.error ?? 'scan failed')
      onNotify?.(
        'success',
        'Eval scan finished',
        `scanned ${json.scanned ?? 0} · predicted ${json.predictCount ?? 0}${
          json.shadow === false ? ` · paper opened ${json.paperOpened ?? 0}` : ' · shadow'
        }`,
      )
      await load()
    } catch (e) {
      onNotify?.(
        'error',
        'Eval scan failed',
        e instanceof Error ? e.message : String(e),
      )
    } finally {
      setRunning(false)
    }
  }

  const mode = data?.mode ?? 'paper'
  const engineOn = data?.enabled === true
  const shadowOn = data?.shadow !== false
  const liveOn = data?.liveTradeEnabled === true
  const last = data?.lastRun

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Eval engine</h2>
          <p className="text-gray-400 text-sm">
            Shadow-by-default candidate scan. Scores and logs predictions; does not
            paper_open / live_open unless EVAL_SHADOW=0. Live trade is stubbed.
          </p>
        </div>
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            !engineOn
              ? 'bg-gray-800 text-gray-400'
              : shadowOn
                ? 'bg-sky-900/60 text-sky-200'
                : mode === 'live'
                  ? 'bg-red-900/60 text-red-200'
                  : 'bg-emerald-900/60 text-emerald-200'
          }`}
        >
          {!engineOn ? 'off' : shadowOn ? 'shadow' : mode}
        </span>
      </div>

      {loading && !data ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : (
        <p className="text-xs text-gray-500">
          EVAL_ENGINE={engineOn ? '1' : '0'} · EVAL_SHADOW={shadowOn ? '1' : '0'} · EVAL_EXEC_MODE=
          {mode} · LIVE_TRADE_ENABLED={liveOn ? '1' : '0'}
          {last?.finishedAt ? (
            <>
              {' '}
              · last run {new Date(last.finishedAt).toISOString()} · scanned{' '}
              {last.scanned ?? 0} · predicted {last.predictCount ?? 0} · paper{' '}
              {last.paperOpened ?? 0} · skip {last.skipped ?? 0}
            </>
          ) : (
            ' · no run yet'
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={running || !engineOn}
          onClick={() => void runScan()}
          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm rounded"
        >
          {running ? 'Scanning…' : 'Run scan'}
        </button>
        <button
          type="button"
          disabled={running}
          onClick={() => void load()}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
        >
          Reload
        </button>
        <a
          href="/api/strategies/ml/eval-report?days=7"
          target="_blank"
          rel="noreferrer"
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded"
        >
          Open 7d report
        </a>
      </div>

      {runs.length > 0 && (
        <div className="overflow-x-auto pt-2">
          <h3 className="text-sm font-semibold text-white mb-2">Recent runs (7d)</h3>
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="text-gray-400 border-b border-gray-700">
                <th className="p-2">Finished</th>
                <th className="p-2">Candidates</th>
                <th className="p-2">Predictions</th>
                <th className="p-2">Resolved</th>
                <th className="p-2">Correct</th>
                <th className="p-2">Accuracy</th>
                <th className="p-2">Avg score win/loss</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.runId}
                  className={`border-b border-gray-800 text-gray-300 cursor-pointer hover:bg-gray-800/50 ${
                    selectedRunId === run.runId ? 'bg-gray-800/70' : ''
                  }`}
                  onClick={() => void loadRun(run.runId)}
                >
                  <td className="p-2 font-mono text-gray-400">
                    {run.finishedAt ? new Date(run.finishedAt).toISOString().slice(0, 19) : '—'}
                  </td>
                  <td className="p-2">{run.candidateCount}</td>
                  <td className="p-2">{run.predictCount}</td>
                  <td className="p-2">{run.resolved}</td>
                  <td className="p-2">{run.correct}</td>
                  <td className="p-2">{pct(run.accuracy)}</td>
                  <td className="p-2">
                    {score(run.avgPredictedScoreWins)} / {score(run.avgPredictedScoreLosses)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedRunId && (
        <div className="pt-1">
          <h3 className="text-sm font-semibold text-white mb-2">
            Predictions · {selectedRunId.slice(0, 8)}
          </h3>
          {loadingPreds ? (
            <p className="text-xs text-gray-500">Loading predictions…</p>
          ) : predictions.length === 0 ? (
            <p className="text-xs text-gray-500">No predictions stored for this run.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="p-2">Mint</th>
                    <th className="p-2">Strategy</th>
                    <th className="p-2">Predicted</th>
                    <th className="p-2">Score</th>
                    <th className="p-2">Model</th>
                    <th className="p-2">Actual</th>
                    <th className="p-2">Correct</th>
                  </tr>
                </thead>
                <tbody>
                  {predictions.map((p) => (
                    <tr key={p.id} className="border-b border-gray-800 text-gray-300">
                      <td className="p-2 font-mono">{p.mint.slice(0, 8)}…</td>
                      <td className="p-2">{p.strategyId}</td>
                      <td className="p-2">{p.predictedLabel}</td>
                      <td className="p-2">{score(p.predictedScore)}</td>
                      <td className="p-2">{p.modelVersion ?? '—'}</td>
                      <td className="p-2">{p.actualLabel ?? '—'}</td>
                      <td className="p-2">
                        {p.correct == null ? '—' : p.correct ? 'yes' : 'no'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
