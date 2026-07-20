'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_OHLC_RUG_THRESHOLDS,
  evaluateOhlcRugRules,
  type OhlcRugBar,
  type OhlcRugThresholds,
} from '@/strategies/ohlc-rug-rules'

type SnapshotResponse = {
  success: boolean
  error?: string
  bars: OhlcRugBar[]
  barCount: number
  rug_label: 'system' | 'rug' | 'not_rug'
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

/** Tiny SVG candlesticks for the 10% rail. */
function MiniCandles({
  bars,
  trip,
}: {
  bars: OhlcRugBar[]
  trip: boolean
}) {
  if (bars.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center text-[9px] text-gray-500">
        No OHLC
      </div>
    )
  }
  const highs = bars.map((b) => b.h)
  const lows = bars.map((b) => b.l)
  const maxH = Math.max(...highs)
  const minL = Math.min(...lows)
  const span = Math.max(maxH - minL, 1e-12)
  const w = 100
  const h = 56
  const pad = 2
  const slot = (w - pad * 2) / bars.length

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-16 w-full"
      role="img"
      aria-label="OHLC mini chart"
    >
      <rect
        width={w}
        height={h}
        fill={trip ? '#450a0a' : '#0a0a0a'}
        rx={2}
      />
      {bars.map((b, i) => {
        const x = pad + i * slot + slot / 2
        const y = (price: number) =>
          pad + ((maxH - price) / span) * (h - pad * 2)
        const yH = y(b.h)
        const yL = y(b.l)
        const yO = y(b.o)
        const yC = y(b.c)
        const up = b.c >= b.o
        const color = up ? '#34d399' : '#f87171'
        const bodyTop = Math.min(yO, yC)
        const bodyBot = Math.max(yO, yC)
        const bodyH = Math.max(bodyBot - bodyTop, 0.8)
        return (
          <g key={b.t}>
            <line
              x1={x}
              x2={x}
              y1={yH}
              y2={yL}
              stroke={color}
              strokeWidth={0.6}
            />
            <rect
              x={x - Math.max(slot * 0.25, 0.8)}
              y={bodyTop}
              width={Math.max(slot * 0.5, 1.2)}
              height={bodyH}
              fill={color}
            />
          </g>
        )
      })}
    </svg>
  )
}

export default function OhlcRugPanel({
  tokenAddress,
}: {
  tokenAddress: string
}) {
  const qc = useQueryClient()
  const [thresholds, setThresholds] = useState<OhlcRugThresholds>({
    ...DEFAULT_OHLC_RUG_THRESHOLDS,
  })

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
    mutationFn: async (rug_label: 'system' | 'rug' | 'not_rug') => {
      const res = await fetch('/api/gmgn/detect-snapshot', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: tokenAddress, rug_label }),
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
    },
  })

  if (query.isLoading) {
    return (
      <div className="h-full animate-pulse rounded-lg border border-gray-700 bg-gray-900/80" />
    )
  }

  if (query.error || !query.data) {
    return (
      <p className="rounded-lg border border-gray-700 bg-gray-900/60 px-1.5 py-1 text-[9px] text-amber-200/80">
        OHLC rules unavailable
      </p>
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

      <MiniCandles bars={query.data.bars} trip={live.trip} />

      <label className="block text-[8px] text-gray-500">
        Label
        <select
          className="mt-0.5 w-full rounded border border-gray-700 bg-gray-900 px-1 py-0.5 text-[10px] text-gray-100"
          value={label}
          disabled={labelMut.isPending}
          onChange={(e) => {
            const v = e.target.value as 'system' | 'rug' | 'not_rug'
            labelMut.mutate(v)
          }}
        >
          <option value="system">system</option>
          <option value="rug">rug</option>
          <option value="not_rug">not_rug</option>
        </select>
      </label>

      <div className="space-y-1 border-t border-gray-800 pt-1">
        <p className="text-[8px] font-semibold uppercase tracking-wide text-gray-500">
          Rules (live tweak)
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
              setThresholds((t) => ({
                ...t,
                dumpPct: Number(e.target.value) / 100,
              }))
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
              setThresholds((t) => ({
                ...t,
                wickRatio: Number(e.target.value) / 100,
              }))
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
              setThresholds((t) => ({
                ...t,
                volDeathRatio: Number(e.target.value) / 100,
              }))
            }
            className="mt-0.5 w-full"
          />
        </label>
      </div>
    </div>
  )
}
