'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type {
  TokenChartOutcomeSegment,
  TokenChartPoint,
  TokenOhlcBar,
} from '@/strategies/token-map-chart'
import {
  CLOSE_MARKER,
  OPEN_MARKER,
  buildTidiedMarkers,
  candleIntervalSec,
} from '@/strategies/token-map-chart-markers'
import {
  CHART_TZ,
  DOMAIN_COLORS,
  GRAY_CANDLE,
  GRAY_WICK,
  formatPriceLabel,
  meanPairwiseOverlapCorr,
  outcomeWindows,
  paintCandles,
  priceFormatFor,
} from '@/strategies/token-map-strategy-chart-paint'
import type {
  TokenMapActivityItem,
  TokenMapActivityKind,
  TokenMapDomain,
} from '@/strategies/token-map-types'

type ChartPayload = {
  points: TokenChartPoint[]
  outcomes: TokenChartOutcomeSegment[]
  candles: TokenOhlcBar[]
  priceSource: 'tracker' | 'empty'
  ohlcSource: string
}

const TOGGLE_DOMAINS = (
  Object.keys(DOMAIN_COLORS) as TokenMapDomain[]
).filter((d) => d !== 'infra')

function toUtc(sec: number): UTCTimestamp {
  return sec as UTCTimestamp
}

const bangkokTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: CHART_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const bangkokDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: CHART_TZ,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formatTickMark(time: Time): string {
  const sec =
    typeof time === 'number'
      ? time
      : typeof time === 'string'
        ? Math.floor(new Date(time).getTime() / 1000)
        : Date.UTC(time.year, time.month - 1, time.day) / 1000
  return bangkokTime.format(new Date(sec * 1000))
}

function formatCrosshairTime(time: Time): string {
  const sec =
    typeof time === 'number'
      ? time
      : typeof time === 'string'
        ? Math.floor(new Date(time).getTime() / 1000)
        : Date.UTC(time.year, time.month - 1, time.day) / 1000
  return bangkokDateTime.format(new Date(sec * 1000))
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
  return [
    { t: min - 60, priceUsd: 1 },
    { t: max + 60, priceUsd: 1 },
  ]
}

function toSeriesMarkers(
  activities: TokenMapActivityItem[],
  outcomes: TokenChartOutcomeSegment[],
  enabled: ReadonlySet<TokenMapDomain>,
  intervalSec: number,
): SeriesMarker<Time>[] {
  return buildTidiedMarkers({
    activities,
    outcomes,
    enabled,
    intervalSec,
  }).map((m) => ({
    time: toUtc(m.time),
    position: m.position,
    shape: m.shape,
    color: m.color,
    size: m.size,
    ...(m.text ? { text: m.text } : {}),
  }))
}

const KIND_LEGEND: {
  kind: TokenMapActivityKind | 'outcome_entry' | 'open' | 'close' | 'cluster'
  label: string
  hint: string
  color?: string
}[] = [
  { kind: 'open', label: 'Open', hint: '↑', color: OPEN_MARKER },
  { kind: 'close', label: 'Close', hint: '↓', color: CLOSE_MARKER },
  { kind: 'gmgn_hot', label: 'Social/GMGN dots', hint: '●' },
  { kind: 'cluster', label: 'clustered', hint: '×N' },
]

export default function TokenMapStrategyChart({
  tokenAddress,
  activities,
  hours = 24,
  chain,
}: {
  tokenAddress: string
  activities: TokenMapActivityItem[]
  hours?: number
  chain?: 'sol' | 'robinhood'
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const mainSeriesRef = useRef<
    ISeriesApi<'Line'> | ISeriesApi<'Candlestick'> | null
  >(null)
  const payloadRef = useRef<ChartPayload | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [lastPrice, setLastPrice] = useState<number | null>(null)
  const [corr, setCorr] = useState<number | null>(null)
  const [enabledDomains, setEnabledDomains] = useState<Set<TokenMapDomain>>(
    () => new Set(TOGGLE_DOMAINS),
  )

  const activityKey = useMemo(
    () => activities.map((a) => `${a.id}:${a.occurredAt}:${a.kind}`).join('|'),
    [activities],
  )

  const enabledKey = useMemo(
    () => TOGGLE_DOMAINS.filter((d) => enabledDomains.has(d)).join(','),
    [enabledDomains],
  )

  const applyDomainPaint = useCallback(
    (payload: ChartPayload, enabled: ReadonlySet<TokenMapDomain>) => {
      const windows = outcomeWindows(payload.outcomes, enabled)
      if (candleSeriesRef.current && payload.candles.length > 0) {
        const painted = paintCandles(payload.candles, windows)
        candleSeriesRef.current.setData(
          painted.map((c) => ({
            time: toUtc(c.time),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            color: c.color,
            wickColor: c.wickColor,
            borderColor: c.borderColor,
          })),
        )
      }
      const intervalSec = candleIntervalSec(payload.candles)
      const markers = toSeriesMarkers(
        activities,
        payload.outcomes,
        enabled,
        intervalSec,
      )
      if (mainSeriesRef.current) {
        markersRef.current?.detach()
        markersRef.current =
          markers.length > 0
            ? createSeriesMarkers(mainSeriesRef.current, markers)
            : null
      }
      setCorr(meanPairwiseOverlapCorr(payload.outcomes, enabled))
    },
    [activities],
  )

  const toggleDomain = (domain: TokenMapDomain) => {
    setEnabledDomains((prev) => {
      const next = new Set(prev)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  // Fetch + build chart when token/hours/activities change
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
        const qs = new URLSearchParams({
          address: tokenAddress,
          hours: String(hours),
        })
        if (chain) qs.set('chain', chain)
        const res = await fetch(`/api/strategies/token-chart?${qs}`)
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

      payloadRef.current = payload
      chartRef.current?.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      mainSeriesRef.current = null
      markersRef.current = null

      const lastClose =
        payload.candles.length > 0
          ? payload.candles[payload.candles.length - 1]!.close
          : payload.points.length > 0
            ? payload.points[payload.points.length - 1]!.priceUsd
            : null
      setLastPrice(lastClose)
      const pf = priceFormatFor(lastClose ?? 0)

      const chart = createChart(containerRef.current, {
        height: 260,
        layout: {
          background: { type: ColorType.Solid, color: '#111827' },
          textColor: '#9ca3af',
        },
        localization: {
          locale: 'en-GB',
          timeFormatter: formatCrosshairTime,
          priceFormatter: (p: number) => formatPriceLabel(p),
        },
        grid: {
          vertLines: { color: '#1f2937' },
          horzLines: { color: '#1f2937' },
        },
        rightPriceScale: { borderColor: '#374151' },
        timeScale: {
          borderColor: '#374151',
          timeVisible: true,
          tickMarkFormatter: formatTickMark,
        },
      })
      chartRef.current = chart

      const useCandles = payload.candles.length > 0
      let mainSeries: ISeriesApi<'Line'> | ISeriesApi<'Candlestick'>
      let linePoints = payload.points

      if (useCandles) {
        const candleSeries = chart.addSeries(CandlestickSeries, {
          upColor: GRAY_CANDLE,
          downColor: GRAY_CANDLE,
          borderVisible: false,
          wickUpColor: GRAY_WICK,
          wickDownColor: GRAY_WICK,
          priceFormat: pf,
        })
        candleSeriesRef.current = candleSeries
        mainSeries = candleSeries

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
              color: '#4b556355',
            })),
        )
        setNote(
          payload.ohlcSource && payload.ohlcSource !== 'none'
            ? `OHLC: ${payload.ohlcSource} · ${CHART_TZ}`
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
          priceFormat: pf,
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

      mainSeriesRef.current = mainSeries
      applyDomainPaint(payload, enabledDomains)

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
      markersRef.current?.detach()
      markersRef.current = null
      chartRef.current?.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      mainSeriesRef.current = null
    }
    // enabledDomains applied in separate effect after mount; initial paint uses current set
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on token/hours/activities/refresh
  }, [tokenAddress, hours, chain, activityKey, activities, applyDomainPaint, refreshKey])

  // Re-paint candles/markers when domain toggles change (no refetch)
  useEffect(() => {
    const payload = payloadRef.current
    if (!payload || !mainSeriesRef.current) return
    applyDomainPaint(payload, enabledDomains)
  }, [enabledKey, enabledDomains, applyDomainPaint])

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/60 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-xs font-medium text-gray-300 shrink-0">
            Strategy correlation
          </p>
          {lastPrice != null ? (
            <span className="text-xs text-gray-400 truncate">
              last {formatPriceLabel(lastPrice)}
            </span>
          ) : null}
          {corr != null ? (
            <span className="text-xs text-emerald-300/90 shrink-0">
              corr: {corr.toFixed(2)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {loading ? (
            <span className="text-xs text-gray-500">
              {refreshKey > 0 ? 'Refreshing…' : 'Loading…'}
            </span>
          ) : null}
          <button
            type="button"
            disabled={loading}
            onClick={() => setRefreshKey((k) => k + 1)}
            className="rounded border border-gray-600 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </div>
      {error ? (
        <p className="px-3 py-4 text-xs text-red-300">{error}</p>
      ) : (
        <div ref={containerRef} className="w-full" />
      )}
      {note ? (
        <p className="px-3 py-1.5 text-xs text-amber-200/80 border-t border-gray-800">
          {note}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 border-t border-gray-800 text-xs text-gray-400">
        {KIND_LEGEND.map((row) => (
          <span key={row.kind} className="inline-flex items-center gap-1">
            <span style={row.color ? { color: row.color } : undefined}>
              {row.hint}
            </span>{' '}
            {row.label}
          </span>
        ))}
        <span className="text-gray-600">|</span>
        {TOGGLE_DOMAINS.map((d) => {
          const on = enabledDomains.has(d)
          return (
            <button
              key={d}
              type="button"
              onClick={() => toggleDomain(d)}
              className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-opacity ${
                on ? 'opacity-100' : 'opacity-35'
              }`}
              title={on ? `Hide ${d}` : `Show ${d}`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: DOMAIN_COLORS[d] }}
              />
              {d.replace('_', ' ')}
            </button>
          )
        })}
      </div>
    </div>
  )
}
