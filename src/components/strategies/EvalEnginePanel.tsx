'use client'

import { useCallback, useEffect, useState } from 'react'

type LastRun = {
  runId?: string
  mode?: string
  scanned?: number
  skipped?: number
  paperOpened?: number
  liveAttempted?: number
  errors?: number
  finishedAt?: string
  enabled?: boolean
}

type StatusApi = {
  success: boolean
  enabled?: boolean
  mode?: 'paper' | 'live'
  liveTradeEnabled?: boolean
  lastRun?: LastRun | null
  error?: string
}

type Props = {
  onNotify?: (kind: 'success' | 'error', title: string, detail?: string) => void
}

export default function EvalEnginePanel({ onNotify }: Props) {
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [data, setData] = useState<StatusApi | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/strategies/ml/eval-scan')
      const json = (await res.json()) as StatusApi
      if (!json.success) throw new Error(json.error ?? 'load failed')
      setData(json)
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

  const runScan = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/strategies/ml/eval-scan', {
        method: 'POST',
        credentials: 'include',
      })
      const json = (await res.json()) as { success?: boolean; error?: string; paperOpened?: number; scanned?: number }
      if (!json.success) throw new Error(json.error ?? 'scan failed')
      onNotify?.(
        'success',
        'Eval scan finished',
        `scanned ${json.scanned ?? 0} · paper opened ${json.paperOpened ?? 0}`,
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
  const liveOn = data?.liveTradeEnabled === true
  const last = data?.lastRun

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Eval engine</h2>
          <p className="text-gray-400 text-sm">
            Live-paper candidate scan. Paper opens use sim-track + phase-3 score→risk.
            Live trade is stubbed.
          </p>
        </div>
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            !engineOn
              ? 'bg-gray-800 text-gray-400'
              : mode === 'live'
                ? 'bg-red-900/60 text-red-200'
                : 'bg-emerald-900/60 text-emerald-200'
          }`}
        >
          {!engineOn ? 'off' : mode}
        </span>
      </div>

      {loading && !data ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : (
        <p className="text-xs text-gray-500">
          EVAL_ENGINE={engineOn ? '1' : '0'} · EVAL_EXEC_MODE={mode} · LIVE_TRADE_ENABLED=
          {liveOn ? '1' : '0'}
          {last?.finishedAt ? (
            <>
              {' '}
              · last run {new Date(last.finishedAt).toISOString()} · scanned{' '}
              {last.scanned ?? 0} · paper {last.paperOpened ?? 0} · skip {last.skipped ?? 0}
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
    </section>
  )
}
