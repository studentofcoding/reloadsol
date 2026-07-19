'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type {
  TokenChartOutcomeSegment,
  TokenChartPoint,
  TokenOhlcBar,
} from '@/strategies/token-map-chart'
import type {
  TokenMapActivityItem,
  TokenMapActivityKind,
  TokenMapDomain,
} from '@/strategies/token-map-types'

const DOMAIN_COLORS: Record<TokenMapDomain, string> = {
  mcap_tracker: '#a78bfa',
  signals: '#60a5fa',
  gmgn: '#facc15',
  trending_bot: '#34d399',
  dlmm: '#f472b6',
  social: '#94a3b8',
  infra: '#64748b',
}

type ChartPayload = {
  points: TokenChartPoint[]
  outcomes: TokenChartOutcomeSegment[]
  candles: TokenOhlcBar[]
  priceSource: 'tracker' | 'empty'
  ohlcSource: string
}

function toUtc(sec: number): UTCTimestamp {
  return sec as UTCTimestamp
}

function activityMarker(item: TokenMapActivityItem): SeriesMarker<Time> | null {
  const ms = new Date(item.occurredAt).getTime()
  if (!Number.isFinite(ms)) return null
  const time = toUtc(Math.floor(ms / 1000))
  const color = DOMAIN_COLORS[item.domain] ?? '#94a3b8'

  let shape: SeriesMarker<Time>['shape'] = 'circle'
  let position: SeriesMarker<Time>['position'] = 'inBar'
  if (item.kind === 'sim_open') {
    shape = 'arrowUp'
    position = 'belowBar'
  } else if (item.kind === 'sim_close') {
    shape = 'arrowDown'
    position = 'aboveBar'
  } else if (item.kind === 'outcome') {
    // Entry/exit drawn from chart API outcomes; skip collapsed activity duplicate
    return null
  } else if (item.kind === 'gmgn_hot' || item.kind === 'live_boost') {
    shape = 'circle'
    position = 'aboveBar'
  }

  return {
    time,
    position,
    shape,
    color,
    size: 1.25,
    text: item.title.slice(0, 28),
  }
}

function outcomeMarkers(seg: TokenChartOutcomeSegment): SeriesMarker<Time>[] {
  const color = DOMAIN_COLORS[seg.domain] ?? '#a78bfa'
  const out: SeriesMarker<Time>[] = []
  if (seg.entryAt) {
    const t = Math.floor(new Date(seg.entryAt).getTime() / 1000)
    if (Number.isFinite(t)) {
      out.push({
        time: toUtc(t),
        position: 'belowBar',
        shape: 'arrowUp',
        color,
        size: 1,
        text: `in ${seg.strategyId.slice(0, 16)}`,
      })
    }
  }
  if (seg.exitAt) {
    const t = Math.floor(new Date(seg.exitAt).getTime() / 1000)
    if (Number.isFinite(t)) {
      const lost = (seg.status ?? '').toLowerCase() === 'lost'
      out.push({
        time: toUtc(t),
        position: 'aboveBar',
        shape: lost ? 'arrowDown' : 'square',
        color: lost ? '#f87171' : color,
        size: 1.1,
        text:
          seg.pnlPct != null
            ? `${seg.pnlPct.toFixed(1)}%`
            : seg.status ?? 'out',
      })
    }
  }
  return out
}

function buildPlaceholderPoints(
  activities: TokenMapActivityItem[],
  outcomes: TokenChartOutcomeSegment[],
): TokenChartPoint[] {
  const times: number[] = []
  for (const a of activities) {
    const t = Math.floor(new Date(a.occurredAt).getTime() / 1000)
    if (Number.isFinite(t)) times.push(t)
  }
  for (const o of outcomes) {
    for (const iso of [o.entryAt, o.exitAt]) {
      if (!iso) continue
      const t = Math.floor(new Date(iso).getTime() / 1000)
      if (Number.isFinite(t)) times.push(t)
    }
  }
  if (times.length === 0) return []
  times.sort((a, b) => a - b)
  const min = times[0]!
  const max = times[times.length - 1]!
  const mid = 1
  return [
    { t: min - 60, priceUsd: mid },
    { t: max + 60, priceUsd: mid },
  ]
}

const KIND_LEGEND: { kind: TokenMapActivityKind | 'outcome_entry'; label: string; hint: string }[] =
  [
    { kind: 'sim_open', label: 'Sim open', hint: '↑' },
    { kind: 'sim_close', label: 'Sim sell', hint: '↓' },
    { kind: 'outcome', label: 'Outcome', hint: '■' },
    { kind: 'gmgn_hot', label: 'GMGN hot', hint: '●' },
    { kind: 'live_boost', label: 'Live boost', hint: '●' },
    { kind: 'social_event', label: 'Social', hint: '●' },
  ]

export default function TokenMapStrategyChart({
  tokenAddress,
  activities,
  hours = 24,
}: {
  tokenAddress: string
  activities: TokenMapActivityItem[]
  hours?: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const activityKey = useMemo(
    () => activities.map((a) => `${a.id}:${a.occurredAt}:${a.kind}`).join('|'),
    [activities],
  )

  useEffect(() => {
    let cancelled = false
    const el = containerRef.current
    if (!el || !tokenAddress) return

    setLoading(true)
    setError(null)

    const run = async () => {
      let payload: ChartPayload = {
        points: [],
        outcomes: [],
        candles: [],
        priceSource: 'empty',
        ohlcSource: 'none',
      }
      try {
        const res = await fetch(
          `/api/strategies/token-chart?address=${encodeURIComponent(tokenAddress)}&hours=${hours}`,
        )
        const json = (await res.json()) as ChartPayload & {
          success?: boolean
          error?: string
        }
        if (!res.ok || json.success === false) {
          throw new Error(json.error || 'Failed to load chart')
        }
        payload = json
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
        return
      }
      if (cancelled || !containerRef.current) return

      chartRef.current?.remove()
      chartRef.current = null

      const chart = createChart(containerRef.current, {
        height: 260,
        layout: {
          background: { type: ColorType.Solid, color: '#111827' },
          textColor: '#9ca3af',
        },
        grid: {
          vertLines: { color: '#1f2937' },
          horzLines: { color: '#1f2937' },
        },
        rightPriceScale: { borderColor: '#374151' },
        timeScale: { borderColor: '#374151', timeVisible: true },
      })
      chartRef.current = chart

      const useCandles = payload.candles.length > 0
      let mainSeries: ISeriesApi<'Line'> | ISeriesApi<'Candlestick'>
      let linePoints = payload.points

      if (useCandles) {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor: '#34d399',
          downColor: '#f87171',
          borderVisible: false,
          wickUpColor: '#34d399',
          wickDownColor: '#f87171',
        })
        mainSeries.setData(
          payload.candles.map((c) => ({
            time: toUtc(c.time),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        )
        const vol = chart.addSeries(HistogramSeries, {
          priceFormat: { type: 'volume' },
          priceScaleId: 'vol',
        })
        chart.priceScale('vol').applyOptions({
          scaleMargins: { top: 0.8, bottom: 0 },
        })
        vol.setData(
          payload.candles
            .filter((c) => c.volume != null)
            .map((c) => ({
              time: toUtc(c.time),
              value: c.volume!,
              color: c.close >= c.open ? '#34d39955' : '#f8717155',
            })),
        )
        setNote(
          payload.ohlcSource && payload.ohlcSource !== 'none'
            ? `OHLC: ${payload.ohlcSource}`
            : null,
        )
      } else {
        if (linePoints.length === 0) {
          linePoints = buildPlaceholderPoints(activities, payload.outcomes)
          setNote(
            linePoints.length > 0
              ? 'No tracker price history — flat axis; markers still show strategy timing.'
              : 'No price history and no strategy events in this window.',
          )
        } else {
          setNote(null)
        }
        mainSeries = chart.addSeries(LineSeries, {
          color: '#60a5fa',
          lineWidth: 2,
          priceLineVisible: false,
        })
        if (linePoints.length > 0) {
          mainSeries.setData(
            linePoints.map((p) => ({
              time: toUtc(p.t),
              value: p.priceUsd,
            })),
          )
        }
      }

      const markers: SeriesMarker<Time>[] = []
      for (const item of activities) {
        const m = activityMarker(item)
        if (m) markers.push(m)
      }
      for (const seg of payload.outcomes) {
        // Prefer dedicated entry/exit markers over the collapsed activity outcome point
        markers.push(...outcomeMarkers(seg))
      }
      markers.sort((a, b) => Number(a.time) - Number(b.time))

      // Deduplicate identical time+text
      const seen = new Set<string>()
      const unique = markers.filter((m) => {
        const key = `${String(m.time)}:${m.text ?? ''}:${m.shape}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      if (unique.length > 0) {
        createSeriesMarkers(mainSeries, unique)
      }

      chart.timeScale().fitContent()
      setLoading(false)
    }

    void run()

    const onResize = () => {
      if (!containerRef.current || !chartRef.current) return
      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
      })
    }
    window.addEventListener('resize', onResize)
    onResize()

    return () => {
      cancelled = true
      window.removeEventListener('resize', onResize)
      chartRef.current?.remove()
      chartRef.current = null
    }
    // activityKey stands in for activities content without remounting on array identity
  }, [tokenAddress, hours, activityKey, activities])

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/60 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <p className="text-xs font-medium text-gray-300">
          Strategy correlation
        </p>
        {loading ? (
          <span className="text-[10px] text-gray-500">Loading…</span>
        ) : null}
      </div>
      {error ? (
        <p className="px-3 py-4 text-xs text-red-300">{error}</p>
      ) : (
        <div ref={containerRef} className="w-full" />
      )}
      {note ? (
        <p className="px-3 py-1.5 text-[10px] text-amber-200/80 border-t border-gray-800">
          {note}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 border-t border-gray-800 text-[10px] text-gray-400">
        {KIND_LEGEND.map((row) => (
          <span key={row.kind}>
            <span className="text-gray-300">{row.hint}</span> {row.label}
          </span>
        ))}
        <span className="text-gray-600">|</span>
        {(Object.keys(DOMAIN_COLORS) as TokenMapDomain[])
          .filter((d) => d !== 'infra')
          .map((d) => (
            <span key={d} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: DOMAIN_COLORS[d] }}
              />
              {d.replace('_', ' ')}
            </span>
          ))}
      </div>
    </div>
  )
}
