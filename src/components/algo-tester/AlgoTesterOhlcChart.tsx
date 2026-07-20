'use client'

import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { TokenOhlcBar } from '@/strategies/token-map-chart'
import {
  CHART_TZ,
  GRAY_WICK,
  formatPriceLabel,
  priceFormatFor,
} from '@/strategies/token-map-strategy-chart-paint'

type PriceHistRow = {
  timestamp?: string | number
  price_usd?: number
}

/** Compact bar shape stored in signal_ohlc_labels */
export type StoredOhlcBar = {
  t: number
  o: number
  h: number
  l: number
  c: number
  v?: number
}

function toUtc(sec: number): UTCTimestamp {
  return sec as UTCTimestamp
}

function parseTsSec(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw)
  }
  if (typeof raw === 'string' && raw.trim()) {
    const ms = new Date(raw).getTime()
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  return null
}

function formatTickMark(time: Time): string {
  const sec = typeof time === 'number' ? time : 0
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CHART_TZ,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(sec * 1000))
}

function simMarkers(sim: unknown): SeriesMarker<Time>[] {
  if (!sim || typeof sim !== 'object') return []
  const s = sim as Record<string, unknown>
  const out: SeriesMarker<Time>[] = []
  const buyAt =
    parseTsSec(s.buy_at) ??
    parseTsSec(s.simulation_started_at) ??
    parseTsSec(s.entry_at)
  const sellAt =
    parseTsSec(s.sell_at) ??
    parseTsSec(s.simulation_ended_at) ??
    parseTsSec(s.exit_at)
  if (buyAt != null) {
    out.push({
      time: toUtc(buyAt),
      position: 'belowBar',
      color: '#34d399',
      shape: 'arrowUp',
      text: 'buy',
    })
  }
  if (sellAt != null) {
    out.push({
      time: toUtc(sellAt),
      position: 'aboveBar',
      color: '#f87171',
      shape: 'arrowDown',
      text: 'sell',
    })
  }
  return out
}

function storedToCandles(bars: StoredOhlcBar[]): TokenOhlcBar[] {
  return bars.map((b) => ({
    time: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    ...(b.v != null ? { volume: b.v } : {}),
  }))
}

const LAST10 = 10

export default function AlgoTesterOhlcChart({
  tokenAddress,
  fromIso,
  toIso,
  priceHistory,
  tradingSimulation,
  bars,
  ohlcSource,
  /** When true (and no stored bars), fetch hours=1 × 1m and take last 10 — same as Freeview. */
  last10 = false,
  height = 280,
}: {
  tokenAddress: string
  fromIso?: string | null
  toIso?: string | null
  priceHistory?: PriceHistRow[] | null
  tradingSimulation?: unknown
  /** When set with length > 0, skip network fetch and paint these bars. */
  bars?: StoredOhlcBar[] | null
  ohlcSource?: string | null
  last10?: boolean
  height?: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function run() {
      if (!containerRef.current) return
      setLoading(true)
      setNote(null)

      chartRef.current?.remove()
      chartRef.current = null

      let candles: TokenOhlcBar[] = []
      let source = ohlcSource ?? 'none'
      let fromSec = parseTsSec(fromIso)
      let toSec = parseTsSec(toIso) ?? Math.floor(Date.now() / 1000)

      if (bars && bars.length > 0) {
        candles = storedToCandles(bars)
        if (fromSec == null) fromSec = candles[0]!.time
        if (!toIso) toSec = candles[candles.length - 1]!.time
        source = ohlcSource || 'stored'
      } else {
        const useLast10 = last10 || fromSec == null
        const qs = useLast10
          ? new URLSearchParams({
              address: tokenAddress,
              hours: '1',
              interval: '1m',
            })
          : new URLSearchParams({
              address: tokenAddress,
              timeFrom: String(fromSec),
              timeTo: String(toSec),
            })
        try {
          const res = await fetch(`/api/gmgn/token-ohlc?${qs}`)
          const json = (await res.json()) as {
            success?: boolean
            candles?: TokenOhlcBar[]
            source?: string
            error?: string
          }
          if (!res.ok || !json.success) {
            setNote(json.error || 'Failed to load OHLC')
            setLoading(false)
            return
          }
          const raw = json.candles ?? []
          candles = useLast10
            ? raw.slice(-LAST10)
            : raw.filter((c) => c.time >= fromSec! && c.time <= toSec)
          if (candles.length > 0) {
            fromSec = candles[0]!.time
            toSec = candles[candles.length - 1]!.time
          }
          source = json.source ?? 'none'
        } catch (e) {
          if (!cancelled) {
            setNote(e instanceof Error ? e.message : 'OHLC fetch failed')
            setLoading(false)
          }
          return
        }
      }

      if (cancelled || !containerRef.current) return

      if (candles.length === 0) {
        setNote('No OHLC bars in this window')
        setLoading(false)
        return
      }

      const lastClose = candles[candles.length - 1]!.close
      const pf = priceFormatFor(lastClose)

      const chart = createChart(containerRef.current, {
        height,
        layout: {
          background: { type: ColorType.Solid, color: '#1f2937' },
          textColor: '#9ca3af',
        },
        localization: {
          locale: 'en-GB',
          timeFormatter: formatTickMark,
          priceFormatter: (p: number) => formatPriceLabel(p),
        },
        grid: {
          vertLines: { color: '#374151' },
          horzLines: { color: '#374151' },
        },
        rightPriceScale: { borderColor: '#4b5563' },
        timeScale: {
          borderColor: '#4b5563',
          timeVisible: true,
          tickMarkFormatter: formatTickMark,
        },
      })
      chartRef.current = chart

      const candleSeries: ISeriesApi<'Candlestick'> = chart.addSeries(
        CandlestickSeries,
        {
          upColor: '#34d399',
          downColor: '#f87171',
          borderVisible: false,
          wickUpColor: GRAY_WICK,
          wickDownColor: GRAY_WICK,
          priceFormat: pf,
        },
      )
      candleSeries.setData(
        candles.map((c) => ({
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
        candles
          .filter((c) => c.volume != null)
          .map((c) => ({
            time: toUtc(c.time),
            value: c.volume!,
            color: c.close >= c.open ? '#34d39955' : '#f8717155',
          })),
      )

      const markers: SeriesMarker<Time>[] = []
      for (const row of priceHistory ?? []) {
        const t = parseTsSec(row.timestamp)
        if (t == null || (fromSec != null && t < fromSec) || t > toSec)
          continue
        markers.push({
          time: toUtc(t),
          position: 'inBar',
          color: '#60a5fa',
          shape: 'circle',
          text: '',
        })
      }
      markers.push(...simMarkers(tradingSimulation))
      markers.sort((a, b) => Number(a.time) - Number(b.time))
      if (markers.length > 0) {
        createSeriesMarkers(candleSeries, markers)
      }

      chart.timeScale().fitContent()
      chart.applyOptions({ width: containerRef.current.clientWidth })
      setNote(
        source !== 'none'
          ? `OHLC ${source} · ${candles.length} bars · ${CHART_TZ}`
          : `${candles.length} bars · ${CHART_TZ}`,
      )
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

    return () => {
      cancelled = true
      window.removeEventListener('resize', onResize)
      chartRef.current?.remove()
      chartRef.current = null
    }
  }, [
    tokenAddress,
    fromIso,
    toIso,
    priceHistory,
    tradingSimulation,
    bars,
    ohlcSource,
    last10,
    height,
  ])

  return (
    <div className="space-y-1">
      {loading ? (
        <div
          className="animate-pulse rounded bg-gray-800"
          style={{ height }}
        />
      ) : null}
      <div
        ref={containerRef}
        className={loading ? 'hidden' : 'w-full'}
      />
      {note ? (
        <p className="text-xs text-gray-400">{note}</p>
      ) : null}
    </div>
  )
}
