'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { SpineDecision } from '@/strategies/spine-tick-log'

const WORKERS = [
  'social_sim_track',
  'signals_sim_track',
  'mcap_tracker_sim_track',
  'gmgn_sim_track',
] as const

type FomoKnobs = {
  id: string
  minMentions30m: number
  simBuySol: number
  maxOpenPositions: number
  takeProfitPct: number
  stopLossPct: number
  maxHoldHours: number
}

type SpinePayload = {
  success: boolean
  ticks: Record<string, SpineDecision[]>
  fomo: FomoKnobs | null
  error?: string
}

function lists(rows: SpineDecision[]) {
  const filtered = rows.filter((r) => !r.passed)
  const passed = rows.filter((r) => r.passed)
  return { filtered, passed }
}

export default function SpinePanel() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['strategy-spine'],
    queryFn: async (): Promise<SpinePayload> => {
      const res = await fetch('/api/strategies/spine')
      const json = (await res.json()) as SpinePayload
      if (!res.ok || !json.success) throw new Error(json.error || 'Spine load failed')
      return json
    },
    refetchInterval: 10_000,
  })
  const fomo = query.data?.fomo
  const [draft, setDraft] = useState<FomoKnobs | null>(null)
  const knobs = draft ?? fomo ?? null

  const save = useMutation({
    mutationFn: async (next: FomoKnobs) => {
      const res = await fetch(`/api/strategies/${next.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            entry: { minMentions30m: next.minMentions30m },
            execution: {
              simBuySol: next.simBuySol,
              maxOpenPositions: next.maxOpenPositions,
            },
            exit: {
              takeProfitPct: next.takeProfitPct,
              stopLossPct: next.stopLossPct,
              maxHoldHours: next.maxHoldHours,
            },
          },
        }),
      })
      const json = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error || 'Save failed')
    },
    onSuccess: async () => {
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: ['strategy-spine'] })
    },
  })

  const run = useMutation({
    mutationFn: async (workerId: string) => {
      const res = await fetch('/api/workers/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId }),
      })
      const json = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error || 'Trigger failed')
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['strategy-spine'] })
    },
  })

  const all = Object.values(query.data?.ticks ?? {}).flat()
  const { filtered, passed } = lists(all)

  return (
    <div className="space-y-4 text-sm text-gray-200">
      <p className="text-gray-400">
        Last paper tick from the existing sim-track cron. Filtered tokens stopped
        before a buy. Passed tokens opened with closed-loop size and exit.
      </p>
      <div className="flex flex-wrap gap-2">
        {WORKERS.map((id) => (
          <button
            key={id}
            type="button"
            className="rounded border border-gray-600 px-2 py-1 text-xs hover:bg-gray-800 disabled:opacity-50"
            disabled={run.isPending}
            onClick={() => run.mutate(id)}
          >
            Run {id}
          </button>
        ))}
      </div>
      {query.isError ? (
        <p className="text-red-300">{(query.error as Error).message}</p>
      ) : null}
      {run.isError ? (
        <p className="text-red-300">{(run.error as Error).message}</p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <DecisionList title="Filtered" rows={filtered} />
        <DecisionList title="Passed" rows={passed} />
      </div>
      {knobs ? (
        <form
          className="grid max-w-xl grid-cols-2 gap-2 rounded border border-gray-700 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate(knobs)
          }}
        >
          <p className="col-span-2 text-xs uppercase tracking-wide text-gray-500">
            FOMO knobs (next cron tick)
          </p>
          <Knob
            label="Mentions >"
            value={knobs.minMentions30m}
            onChange={(n) => setDraft({ ...knobs, minMentions30m: n })}
          />
          <Knob
            label="Sim SOL"
            value={knobs.simBuySol}
            step="0.01"
            onChange={(n) => setDraft({ ...knobs, simBuySol: n })}
          />
          <Knob
            label="Max open"
            value={knobs.maxOpenPositions}
            onChange={(n) => setDraft({ ...knobs, maxOpenPositions: n })}
          />
          <Knob
            label="Base TP %"
            value={knobs.takeProfitPct}
            onChange={(n) => setDraft({ ...knobs, takeProfitPct: n })}
          />
          <Knob
            label="Base SL %"
            value={knobs.stopLossPct}
            onChange={(n) => setDraft({ ...knobs, stopLossPct: n })}
          />
          <Knob
            label="Max hold h"
            value={knobs.maxHoldHours}
            onChange={(n) => setDraft({ ...knobs, maxHoldHours: n })}
          />
          <button
            type="submit"
            disabled={save.isPending}
            className="col-span-2 rounded bg-blue-700 px-3 py-1.5 text-white disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save knobs'}
          </button>
          {save.isError ? (
            <p className="col-span-2 text-red-300">{(save.error as Error).message}</p>
          ) : null}
        </form>
      ) : null}
    </div>
  )
}

function Knob({
  label,
  value,
  onChange,
  step = '1',
}: {
  label: string
  value: number
  step?: string
  onChange: (n: number) => void
}) {
  return (
    <label className="text-xs text-gray-400">
      {label}
      <input
        className="mt-1 w-full rounded border border-gray-600 bg-gray-900 px-2 py-1 text-white"
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

function DecisionList({
  title,
  rows,
}: {
  title: string
  rows: SpineDecision[]
}) {
  const sorted = [...rows].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30)
  return (
    <div>
      <h3 className="mb-2 font-medium text-white">
        {title} ({rows.length})
      </h3>
      <ul className="space-y-1 font-mono text-xs">
        {sorted.length === 0 ? <li className="text-gray-500">None yet</li> : null}
        {sorted.map((row, i) => (
          <li key={`${row.at}-${row.mint}-${i}`} className="text-gray-300">
            {row.symbol ?? row.mint.slice(0, 6)} · {row.stage}
            {row.reason ? ` · ${row.reason}` : ''}
            {row.passed
              ? ` · p ${row.p?.toFixed(2)} · ${row.solAmount} SOL · TP ${row.takeProfitPct} / SL ${row.stopLossPct}`
              : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
