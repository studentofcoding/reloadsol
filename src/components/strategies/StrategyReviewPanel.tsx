'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StrategyReviewPayload } from '@/strategies/strategy-review'

const LOCAL_NOTES_KEY = 'strategy-review-notes'
const LOCAL_MIGRATED_KEY = 'strategy-review-notes-migrated'

type ReviewQueryData = {
  success: boolean
  error?: string
  review?: StrategyReviewPayload
  notes?: Record<string, string>
  rowCount?: number
}

function readLocalNotes(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(LOCAL_NOTES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function cellColor(n: number): string {
  if (n <= 0) return 'bg-gray-900 text-gray-600'
  if (n === 1) return 'bg-amber-950/60 text-amber-200'
  if (n <= 3) return 'bg-orange-900/50 text-orange-200'
  return 'bg-red-900/60 text-red-200'
}

export default function StrategyReviewPanel() {
  const queryClient = useQueryClient()
  const [weeks, setWeeks] = useState(12)
  const [domain, setDomain] = useState('')
  const [noteWeek, setNoteWeek] = useState('')
  const [draftByWeek, setDraftByWeek] = useState<Record<string, string>>({})
  const [savingNote, setSavingNote] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [patterns, setPatterns] = useState<string[] | null>(null)
  const [analyzeSource, setAnalyzeSource] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const migratedRef = useRef(false)

  const queryKey = ['strategy-review', weeks, domain] as const

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ weeks: String(weeks) })
      if (domain) params.set('domain', domain)
      const res = await fetch(`/api/strategies/review?${params}`)
      const json = (await res.json()) as ReviewQueryData
      if (!json.success || !json.review) {
        throw new Error(json.error || 'Failed to load review')
      }
      return json
    },
  })

  const review = query.data?.review
  const notes = query.data?.notes ?? {}

  // One-shot localStorage → DB; setQueryData only in async callback (not sync in effect)
  useEffect(() => {
    if (migratedRef.current || !query.isSuccess) return
    if (typeof window === 'undefined') return
    if (localStorage.getItem(LOCAL_MIGRATED_KEY) === '1') {
      migratedRef.current = true
      return
    }
    const local = readLocalNotes()
    const entries = Object.entries(local).filter(([, v]) => v.trim())
    if (entries.length === 0) {
      localStorage.setItem(LOCAL_MIGRATED_KEY, '1')
      migratedRef.current = true
      return
    }
    migratedRef.current = true
    void fetch('/api/strategies/review/notes', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes: Object.fromEntries(entries) }),
    })
      .then(async (res) => {
        const json = (await res.json()) as {
          success?: boolean
          notes?: Record<string, string>
        }
        if (json.success && json.notes) {
          queryClient.setQueryData<ReviewQueryData>(queryKey, (old) =>
            old ? { ...old, notes: { ...json.notes, ...(old.notes ?? {}) } } : old,
          )
        }
        localStorage.setItem(LOCAL_MIGRATED_KEY, '1')
        localStorage.removeItem(LOCAL_NOTES_KEY)
      })
      .catch(() => {
        migratedRef.current = false
      })
  }, [query.isSuccess, queryClient, queryKey])

  const activeNoteWeek = noteWeek || review?.weeks[review.weeks.length - 1]?.weekKey || ''
  const noteText =
    activeNoteWeek && Object.prototype.hasOwnProperty.call(draftByWeek, activeNoteWeek)
      ? draftByWeek[activeNoteWeek]!
      : (notes[activeNoteWeek] ?? '')

  const persistNote = useCallback(async () => {
    if (!activeNoteWeek) return
    setSavingNote(true)
    setSaveMsg(null)
    try {
      const res = await fetch('/api/strategies/review/notes', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ periodKey: activeNoteWeek, note: noteText }),
      })
      const json = (await res.json()) as {
        success: boolean
        note?: string
        deleted?: boolean
        error?: string
      }
      if (!json.success) throw new Error(json.error || 'Save failed')
      queryClient.setQueryData<ReviewQueryData>(queryKey, (old) => {
        if (!old) return old
        const nextNotes = { ...(old.notes ?? {}) }
        if (json.deleted || !noteText.trim()) delete nextNotes[activeNoteWeek]
        else nextNotes[activeNoteWeek] = json.note ?? noteText.trim()
        return { ...old, notes: nextNotes }
      })
      setDraftByWeek((prev) => {
        const next = { ...prev }
        delete next[activeNoteWeek]
        return next
      })
      setSaveMsg(json.deleted ? 'Cleared' : 'Saved')
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingNote(false)
    }
  }, [activeNoteWeek, noteText, queryClient, queryKey])

  async function runAnalyze() {
    if (!review) return
    setAnalyzing(true)
    setPatterns(null)
    try {
      const res = await fetch('/api/strategies/review/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ review, notesByWeek: notes }),
      })
      const json = (await res.json()) as {
        success: boolean
        patterns?: string[]
        source?: string
        error?: string
      }
      if (!json.success) throw new Error(json.error || 'Analyze failed')
      setPatterns(json.patterns ?? [])
      setAnalyzeSource(json.source ?? null)
    } catch (e) {
      setPatterns([e instanceof Error ? e.message : String(e)])
      setAnalyzeSource('error')
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-bold text-white mb-1">Strategy review</h2>
        <p className="text-gray-400 text-sm mb-4">
          Closed outcomes by week — streaks, punch-card, setup scorecard. Notes sync via DB
          (overwrite by week key).
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-xs text-gray-400">
            Weeks
            <select
              className="mt-1 block bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white"
              value={weeks}
              onChange={(e) => setWeeks(Number(e.target.value))}
            >
              {[4, 8, 12, 16, 26].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-400">
            Domain
            <select
              className="mt-1 block bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            >
              <option value="">All</option>
              <option value="gmgn">gmgn</option>
              <option value="mcap_tracker">mcap_tracker</option>
              <option value="signals">signals</option>
              <option value="trending_bot">trending_bot</option>
              <option value="dlmm">dlmm</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="px-3 py-1.5 text-sm rounded bg-gray-700 text-white hover:bg-gray-600"
          >
            Refresh
          </button>
        </div>
        {query.isLoading && <p className="text-gray-500 text-sm mt-3">Loading…</p>}
        {query.error && (
          <p className="text-red-400 text-sm mt-3">
            {query.error instanceof Error ? query.error.message : String(query.error)}
          </p>
        )}
        {review && (
          <div className="mt-4 grid gap-3 sm:grid-cols-4 text-sm">
            <div className="bg-gray-950/60 border border-gray-800 rounded p-3">
              <div className="text-gray-500 text-xs">Trades</div>
              <div className="text-white font-semibold">{review.periodSummary.tradeCount}</div>
            </div>
            <div className="bg-gray-950/60 border border-gray-800 rounded p-3">
              <div className="text-gray-500 text-xs">Win rate</div>
              <div className="text-white font-semibold">
                {(review.periodSummary.winRate * 100).toFixed(1)}%
              </div>
            </div>
            <div className="bg-gray-950/60 border border-gray-800 rounded p-3">
              <div className="text-gray-500 text-xs">Avg PnL</div>
              <div className="text-white font-semibold">
                {review.periodSummary.avgPnlPct.toFixed(2)}%
              </div>
            </div>
            <div className="bg-gray-950/60 border border-gray-800 rounded p-3">
              <div className="text-gray-500 text-xs">Net PnL</div>
              <div className="text-white font-semibold">
                {review.periodSummary.totalPnlPct.toFixed(1)}%
              </div>
            </div>
          </div>
        )}
      </section>

      {review && review.streaks.length > 0 && (
        <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-3">Active streaks (2+ weeks)</h3>
          <ul className="space-y-2 text-sm">
            {review.streaks.slice(0, 12).map((s) => (
              <li
                key={`${s.tag}-${s.weeks.join(',')}`}
                className="flex flex-wrap gap-2 items-baseline text-amber-200"
              >
                <span className="font-mono text-xs bg-amber-950/50 px-2 py-0.5 rounded">
                  {s.length}w
                </span>
                <span className="text-white">{s.tag}</span>
                <span className="text-gray-500 text-xs">{s.weeks.join(' → ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {review && review.punchCard.tags.length > 0 && (
        <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 overflow-x-auto">
          <h3 className="text-lg font-semibold text-white mb-3">Punch card (tags × weeks)</h3>
          <table className="text-[10px] border-collapse">
            <thead>
              <tr>
                <th className="text-left text-gray-500 p-1 sticky left-0 bg-gray-900">tag</th>
                {review.punchCard.weeks.map((w) => (
                  <th key={w} className="text-gray-500 p-1 font-normal whitespace-nowrap">
                    {w.replace(/^\d{4}-/, '')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {review.punchCard.tags.map((tag, ti) => (
                <tr key={tag}>
                  <td className="text-gray-300 p-1 pr-2 font-mono whitespace-nowrap sticky left-0 bg-gray-900">
                    {tag}
                  </td>
                  {review.punchCard.counts[ti].map((n, wi) => (
                    <td
                      key={`${tag}-${wi}`}
                      className={`p-1 text-center min-w-[1.5rem] ${cellColor(n)}`}
                      title={`${tag} @ ${review.punchCard.weeks[wi]}: ${n}`}
                    >
                      {n || ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {review && (
        <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="text-lg font-semibold text-green-300 mb-2">Best setups (month)</h3>
            <ul className="text-sm space-y-1">
              {review.scorecard.best.length === 0 && (
                <li className="text-gray-500">Need ≥3 trades/month</li>
              )}
              {review.scorecard.best.map((r) => (
                <li key={`b-${r.monthKey}-${r.strategyId}`} className="text-gray-300">
                  <span className="text-white">{r.domain}/{r.strategyId}</span>{' '}
                  <span className="text-gray-500">{r.monthKey}</span> · net{' '}
                  <span className="text-green-400">{r.totalPnlPct.toFixed(1)}%</span> (
                  {r.tradeCount})
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-red-300 mb-2">Worst setups (month)</h3>
            <ul className="text-sm space-y-1">
              {review.scorecard.worst.length === 0 && (
                <li className="text-gray-500">No losing setups this month</li>
              )}
              {review.scorecard.worst.map((r) => (
                <li key={`w-${r.monthKey}-${r.strategyId}`} className="text-gray-300">
                  <span className="text-white">{r.domain}/{r.strategyId}</span>{' '}
                  <span className="text-gray-500">{r.monthKey}</span> · net{' '}
                  <span className="text-red-400">{r.totalPnlPct.toFixed(1)}%</span> ({r.tradeCount}
                  )
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {review && (
        <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-3">
          <h3 className="text-lg font-semibold text-white">Weekly note</h3>
          <p className="text-xs text-gray-500">Synced to Postgres — same notes on every device.</p>
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-xs text-gray-400">
              Week
              <select
                className="mt-1 block bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white"
                value={activeNoteWeek}
                onChange={(e) => {
                  setNoteWeek(e.target.value)
                  setSaveMsg(null)
                }}
              >
                {review.weeks.map((w) => (
                  <option key={w.weekKey} value={w.weekKey}>
                    {w.weekKey}
                    {notes[w.weekKey] ? ' ·' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={savingNote || !activeNoteWeek}
              onClick={() => void persistNote()}
              className="px-3 py-1.5 text-sm rounded bg-blue-700 text-white hover:bg-blue-600 disabled:opacity-50"
            >
              {savingNote ? 'Saving…' : 'Save note'}
            </button>
            {saveMsg && <span className="text-xs text-gray-400">{saveMsg}</span>}
          </div>
          <textarea
            className="w-full min-h-[80px] bg-gray-950 border border-gray-700 rounded p-2 text-sm text-gray-200"
            placeholder="e.g. cut size on gmgn_hot next week"
            value={noteText}
            onChange={(e) => {
              const week = activeNoteWeek
              if (!week) return
              const value = e.target.value
              setDraftByWeek((prev) => ({ ...prev, [week]: value }))
            }}
          />
          <button
            type="button"
            disabled={analyzing}
            onClick={() => void runAnalyze()}
            className="px-4 py-2 text-sm rounded bg-violet-700 text-white hover:bg-violet-600 disabled:opacity-50"
          >
            {analyzing ? 'Analyzing…' : 'Analyze patterns'}
          </button>
          {patterns && (
            <div className="mt-2">
              <p className="text-xs text-gray-500 mb-2">
                Source: {analyzeSource ?? '—'}
                {analyzeSource === 'heuristic'
                  ? ' · set ANTHROPIC_API_KEY on server for Claude'
                  : ''}
              </p>
              <ol className="list-decimal list-inside space-y-1 text-sm text-gray-200">
                {patterns.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
