'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FieldGrid,
  NumberField,
} from '@/components/strategies/StrategyConfigFields'
import type { CombinedScoreWeights } from '@/strategies/combined-score'

type WeightsApi = {
  success: boolean
  weights: CombinedScoreWeights
  defaults: CombinedScoreWeights
  source?: 'stored' | 'defaults'
  rule?: string
  renormalized?: boolean
  error?: string
}

type Props = {
  onNotify?: (kind: 'success' | 'error', title: string, detail?: string) => void
}

const FIELDS: { key: keyof CombinedScoreWeights; label: string; optional?: boolean }[] = [
  { key: 'principal', label: 'Principal (mcap first_seen / at_80)' },
  { key: 'adjusterPresence', label: 'Adjuster presence' },
  { key: 'jaccard', label: 'Jaccard overlap' },
  { key: 'ohlcPattern', label: 'OHLC rug patterns' },
  { key: 'ml', label: 'ML closed-loop (optional)', optional: true },
]

function toDraft(weights: CombinedScoreWeights): Record<keyof CombinedScoreWeights, string> {
  return {
    principal: String(weights.principal),
    adjusterPresence: String(weights.adjusterPresence),
    jaccard: String(weights.jaccard),
    ohlcPattern: String(weights.ohlcPattern),
    ml: weights.ml == null ? '' : String(weights.ml),
  }
}

function parseDraft(
  draft: Record<keyof CombinedScoreWeights, string>,
): CombinedScoreWeights | null {
  const out = {} as CombinedScoreWeights
  for (const field of FIELDS) {
    const raw = draft[field.key]
    if (field.optional && (raw == null || raw.trim() === '')) continue
    const n = Number(raw)
    if (!Number.isFinite(n)) return null
    out[field.key] = n
  }
  return out
}

export default function CombinedScoreWeightsPanel({ onNotify }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState<WeightsApi | null>(null)
  const [draft, setDraft] = useState<Record<keyof CombinedScoreWeights, string> | null>(
    null,
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/strategies/combined-score/weights')
      const json = (await res.json()) as WeightsApi
      if (!json.success) throw new Error(json.error ?? 'load failed')
      setData(json)
      setDraft(toDraft(json.weights))
    } catch (e) {
      onNotify?.(
        'error',
        'Combined score weights load failed',
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

  const parsed = useMemo(() => (draft ? parseDraft(draft) : null), [draft])
  const draftSum = parsed
    ? parsed.principal +
      parsed.adjusterPresence +
      parsed.jaccard +
      parsed.ohlcPattern +
      (parsed.ml ?? 0)
    : null
  const preview =
    parsed && draftSum != null && draftSum > 0
      ? {
          principal: parsed.principal / draftSum,
          adjusterPresence: parsed.adjusterPresence / draftSum,
          jaccard: parsed.jaccard / draftSum,
          ohlcPattern: parsed.ohlcPattern / draftSum,
          ...(parsed.ml != null ? { ml: parsed.ml / draftSum } : {}),
        }
      : null

  const save = async (opts?: { reset?: boolean }) => {
    setSaving(true)
    try {
      const body: Record<string, unknown> = opts?.reset
        ? { reset: true }
        : { weights: parsed }
      if (!opts?.reset && !parsed) {
        throw new Error('Each weight must be a finite number ≥ 0')
      }
      const res = await fetch('/api/strategies/combined-score/weights', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as WeightsApi
      if (!json.success) throw new Error(json.error ?? 'save failed')
      onNotify?.(
        'success',
        opts?.reset ? 'Combined score weights reset' : 'Combined score weights saved',
        json.renormalized ? 'Renormalized to sum 1' : undefined,
      )
      await load()
    } catch (e) {
      onNotify?.(
        'error',
        'Combined score weights save failed',
        e instanceof Error ? e.message : String(e),
      )
    } finally {
      setSaving(false)
    }
  }

  if (loading || !draft || !data) {
    return (
      <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-bold text-white mb-2">Combined score weights</h2>
        <p className="text-gray-400 text-sm">Loading…</p>
      </section>
    )
  }

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-4">
      <div>
        <h2 className="text-xl font-bold text-white mb-1">Combined score weights</h2>
        <p className="text-gray-400 text-sm">
          Feeds Freeview <span className="text-gray-300">Combined score</span> and{' '}
          <code className="text-xs">GET /api/strategies/combined-score</code>. Defaults{' '}
          <span className="font-mono text-gray-300">0.55 / 0.20 / 0.15 / 0.10</span>.
          Optional <span className="font-mono text-gray-300">ml</span> 5th key
          renormalizes when set. Each weight must be ≥ 0; save renormalizes so they sum to 1.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Source:{' '}
          <span className="font-mono text-gray-300">{data.source ?? 'defaults'}</span>
          {draftSum != null ? (
            <>
              {' '}
              · draft sum{' '}
              <span className="font-mono text-gray-300">{draftSum.toFixed(4)}</span>
            </>
          ) : (
            <span className="text-amber-300"> · invalid draft</span>
          )}
        </p>
      </div>

      <FieldGrid>
        {FIELDS.map((field) => (
          <NumberField
            key={field.key}
            label={
              preview && preview[field.key] != null
                ? `${field.label} → ${preview[field.key]!.toFixed(3)}`
                : field.label
            }
            value={draft[field.key]}
            step="0.01"
            onChange={(v) =>
              setDraft((prev) => (prev ? { ...prev, [field.key]: v } : prev))
            }
          />
        ))}
      </FieldGrid>

      <p className="text-xs text-gray-500">
        v1 defaults: principal {data.defaults.principal.toFixed(2)} · adjuster{' '}
        {data.defaults.adjusterPresence.toFixed(2)} · jaccard{' '}
        {data.defaults.jaccard.toFixed(2)} · ohlc {data.defaults.ohlcPattern.toFixed(2)}
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving || !parsed}
          onClick={() => void save()}
          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm rounded"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save({ reset: true })}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded"
        >
          Reset to defaults
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void load()}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
        >
          Reload
        </button>
      </div>
    </section>
  )
}
