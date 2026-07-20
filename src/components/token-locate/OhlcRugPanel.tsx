'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import MiniOhlcCandles from '@/components/signals/shared/MiniOhlcCandles'
import {
  DEFAULT_OHLC_RUG_THRESHOLDS,
  evaluateOhlcRugRules,
  type OhlcRugBar,
  type OhlcRugThresholds,
} from '@/strategies/ohlc-rug-rules'
import type { DetectRugLabel } from '@/strategies/detect-snapshots'

const THRESHOLDS_KEY = 'ohlc-rug-thresholds-v1'

function loadThresholds(): OhlcRugThresholds {
  if (typeof window === 'undefined') return { ...DEFAULT_OHLC_RUG_THRESHOLDS }
  try {
    const raw = localStorage.getItem(THRESHOLDS_KEY)
    if (!raw) return { ...DEFAULT_OHLC_RUG_THRESHOLDS }
    const parsed = JSON.parse(raw) as Partial<OhlcRugThresholds>
    return {
      dumpPct:
        typeof parsed.dumpPct === 'number'
          ? parsed.dumpPct
          : DEFAULT_OHLC_RUG_THRESHOLDS.dumpPct,
      wickRatio:
        typeof parsed.wickRatio === 'number'
          ? parsed.wickRatio
          : DEFAULT_OHLC_RUG_THRESHOLDS.wickRatio,
      volDeathRatio:
        typeof parsed.volDeathRatio === 'number'
          ? parsed.volDeathRatio
          : DEFAULT_OHLC_RUG_THRESHOLDS.volDeathRatio,
    }
  } catch {
    return { ...DEFAULT_OHLC_RUG_THRESHOLDS }
  }
}

function saveThresholds(t: OhlcRugThresholds): void {
  try {
    localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(t))
  } catch {
    /* quota */
  }
}

type SnapshotResponse = {
  success: boolean
  error?: string
  bars: OhlcRugBar[]
  barCount: number
  rug_label: DetectRugLabel
  snapshot_id: string | null
  trip: boolean
  rule_hits: ReturnType<typeof evaluateOhlcRugRules>['hits']
  features: ReturnType<typeof evaluateOhlcRugRules>['features']
}

function fmtPct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(1)}%`
}

function fmtRatio(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—'
  return ratio.toFixed(3)
}

export default function OhlcRugPanel({
  tokenAddress,
  tokenSymbol,
}: {
  tokenAddress: string
  tokenSymbol?: string | null
}) {
  const qc = useQueryClient()
  const [thresholds, setThresholds] = useState<OhlcRugThresholds>(loadThresholds)

  const setThreshold = (patch: Partial<OhlcRugThresholds>) => {
    setThresholds((prev) => {
      const next = { ...prev, ...patch }
      saveThresholds(next)
      return next
    })
  }

  const query = useQuery({
    queryKey: ['gmgn-detect-snapshot', tokenAddress],
    queryFn: async (): Promise<SnapshotResponse> => {
      const res = await fetch(
        `/api/gmgn/detect-snapshot?address=${encodeURIComponent(tokenAddress)}`,
      )
      const json = (await res.json()) as SnapshotResponse
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load detect snapshot')
      }
      return json
    },
    enabled: Boolean(tokenAddress),
    staleTime: 60_000,
  })

  const live = useMemo(() => {
    const bars = query.data?.bars ?? []
    return evaluateOhlcRugRules(bars, thresholds)
  }, [query.data?.bars, thresholds])

  const labelMut = useMutation({
    mutationFn: async (rug_label: DetectRugLabel) => {
      const res = await fetch('/api/gmgn/detect-snapshot', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: tokenAddress,
          rug_label,
          tokenSymbol: tokenSymbol ?? null,
        }),
      })
      const json = (await res.json()) as {
        success: boolean
        error?: string
        rug_label?: string
      }
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to update label')
      }
      return json
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['gmgn-detect-snapshot', tokenAddress],
      })
      void qc.invalidateQueries({ queryKey: ['potential-list'] })
      void qc.invalidateQueries({ queryKey: ['rug-list'] })
      void qc.invalidateQueries({ queryKey: ['signal-ohlc-labels'] })
    },
  })

  if (query.isLoading) {
    return (
      <div className="h-full animate-pulse rounded-lg border border-gray-700 bg-gray-900/80" />
    )
  }

  if (query.error || !query.data) {
    const detail =
      query.error instanceof Error
        ? query.error.message.slice(0, 120)
        : null
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900/60 px-1.5 py-1 text-[9px] text-amber-200/80">
        <p>OHLC rules unavailable</p>
        {detail ? (
          <p className="mt-0.5 truncate text-[8px] text-amber-200/50" title={detail}>
            {detail}
          </p>
        ) : null}
      </div>
    )
  }

  const n = live.features.n
  const label = query.data.rug_label

  return (
    <div className="flex h-full max-h-[300px] flex-col gap-1 overflow-y-auto rounded-lg border border-gray-700 bg-gray-950/90 p-1.5">
      <div className="flex items-center justify-between gap-1">
        <p className="text-[9px] font-semibold text-gray-300">
          OHLC {n}/10m
        </p>
        <span
          className={`rounded px-1 text-[8px] font-semibold uppercase ${
            live.trip
              ? 'bg-red-900/80 text-red-200'
              : 'bg-emerald-900/60 text-emerald-200'
          }`}
        >
          {live.trip ? 'trip' : 'ok'}
        </span>
      </div>

      <MiniOhlcCandles bars={query.data.bars} trip={live.trip} />

      <label className="block text-[8px] text-gray-500">
        Label
        <select
          className="mt-0.5 w-full rounded border border-gray-700 bg-gray-900 px-1 py-0.5 text-[10px] text-gray-100"
          value={label}
          disabled={labelMut.isPending}
          onChange={(e) => {
            const v = e.target.value as DetectRugLabel
            labelMut.mutate(v)
          }}
        >
          <option value="system">system</option>
          <option value="rug">rug</option>
          <option value="potential">potential</option>
        </select>
      </label>

      <div className="space-y-1 border-t border-gray-800 pt-1">
        <p className="text-[8px] font-semibold uppercase tracking-wide text-gray-500">
          Rules (live tweak · saved)
        </p>
        {live.hits.map((hit) => (
          <div
            key={hit.id}
            className={`rounded px-1 py-0.5 text-[8px] leading-tight ${
              hit.skipped
                ? 'bg-gray-900 text-gray-500'
                : hit.passed
                  ? 'bg-red-950/70 text-red-200'
                  : 'bg-emerald-950/40 text-emerald-200/90'
            }`}
          >
            <p className="font-semibold">{hit.id}</p>
            <p>
              {hit.skipped
                ? hit.skipReason
                : `${hit.id === 'dump_10m' ? fmtPct(hit.value) : fmtRatio(hit.value)} vs ${
                    hit.id === 'dump_10m'
                      ? fmtPct(hit.threshold)
                      : fmtRatio(hit.threshold)
                  }`}
            </p>
          </div>
        ))}
      </div>

      <div className="space-y-1 border-t border-gray-800 pt-1">
        <label className="block text-[8px] text-gray-500">
          Dump ≥ {(thresholds.dumpPct * 100).toFixed(0)}%
          <input
            type="range"
            min={10}
            max={80}
            step={1}
            value={Math.round(thresholds.dumpPct * 100)}
            onChange={(e) =>
              setThreshold({ dumpPct: Number(e.target.value) / 100 })
            }
            className="mt-0.5 w-full"
          />
        </label>
        <label className="block text-[8px] text-gray-500">
          Wick ≥ {thresholds.wickRatio.toFixed(2)}
          <input
            type="range"
            min={20}
            max={90}
            step={1}
            value={Math.round(thresholds.wickRatio * 100)}
            onChange={(e) =>
              setThreshold({ wickRatio: Number(e.target.value) / 100 })
            }
            className="mt-0.5 w-full"
          />
        </label>
        <label className="block text-[8px] text-gray-500">
          Vol death ≤ {thresholds.volDeathRatio.toFixed(2)}
          <input
            type="range"
            min={5}
            max={50}
            step={1}
            value={Math.round(thresholds.volDeathRatio * 100)}
            onChange={(e) =>
              setThreshold({ volDeathRatio: Number(e.target.value) / 100 })
            }
            className="mt-0.5 w-full"
          />
        </label>
      </div>
    </div>
  )
}
