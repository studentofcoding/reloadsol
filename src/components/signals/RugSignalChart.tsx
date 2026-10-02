'use client'

import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { CHART_TZ, GRAY_WICK, formatPriceLabel, priceFormatFor } from '@/strategies/token-map-strategy-chart-paint'

/**
 * The rug signal, drawn from the evidence it judged.
 *
 * The bars are the **market-cap minutes the scorer itself reads** (`token_metrics_history`), not a
 * price series that merely looks similar — the point of the picture is to check the verdict against
 * the same series the verdict came from. Every evaluation in the window is marked, not just the
 * trips, because the non-trips are the control half of the soak.
 *
 * A `would_rug` verdict is a labelled red arrow above the bar it was reached on; ordinary
 * evaluations are faint dots, and an applied rug label is drawn as its own marker so a human label
 * is never confused with the machine's.
 */

export type RugChartBar = { t: number; o: number; h: number; l: number; c: number; v?: number }

export type RugChartMarker = {
  t: number
  decision: string
  score: number | null
}

export type RugChartLabel = { source: string; addedAt: number }

function toUtc(sec: number): UTCTimestamp {
  return sec as UTCTimestamp
}

export default function RugSignalChart({
  bars,
  markers,
  label,
  height = 320,
}: {
  bars: RugChartBar[]
  markers: RugChartMarker[]
  label?: RugChartLabel | null
  height?: number
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [counted, setCounted] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    chartRef.current?.remove()
    chartRef.current = null
    setCounted(0)
    if (bars.length === 0) return

    const lastClose = bars[bars.length - 1]!.c
    const chart = createChart(container, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#111827' },
        textColor: '#9ca3af',
      },
      localization: { priceFormatter: (p: number) => formatPriceLabel(p) },
      grid: { vertLines: { color: '#374151' }, horzLines: { color: '#374151' } },
      rightPriceScale: { borderColor: '#4b5563' },
      timeScale: { borderColor: '#4b5563', timeVisible: true },
    })
    chartRef.current = chart

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#34d399',
      downColor: '#f87171',
      borderVisible: false,
      wickUpColor: GRAY_WICK,
      wickDownColor: GRAY_WICK,
      priceFormat: priceFormatFor(lastClose),
    })
    candles.setData(
      bars.map((b) => ({ time: toUtc(b.t), open: b.o, high: b.h, low: b.l, close: b.c })),
    )

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    volume.setData(
      bars
        .filter((b) => b.v != null)
        .map((b) => ({ time: toUtc(b.t), value: b.v!, color: b.c >= b.o ? '#34d39944' : '#f8717144' })),
    )

    const seriesMarkers: SeriesMarker<Time>[] = markers.map((m) =>
      m.decision === 'would_rug'
        ? {
            time: toUtc(m.t),
            position: 'aboveBar' as const,
            color: '#f87171',
            shape: 'arrowDown' as const,
            text: `rug ${m.score ?? ''}`.trim(),
          }
        : {
            time: toUtc(m.t),
            position: 'inBar' as const,
            color: '#6b7280',
            shape: 'circle' as const,
            text: '',
            size: 0,
          },
    )
    if (label && label.addedAt > 0) {
      seriesMarkers.push({
        time: toUtc(label.addedAt),
        position: 'belowBar',
        color: '#f59e0b',
        shape: 'square',
        text: `label ${label.source}`,
      })
    }
    seriesMarkers.sort((a, b) => Number(a.time) - Number(b.time))
    if (seriesMarkers.length > 0) createSeriesMarkers(candles, seriesMarkers)

    chart.timeScale().fitContent()
    chart.applyOptions({ width: container.clientWidth })
    setCounted(bars.length)

    const onResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chartRef.current?.remove()
      chartRef.current = null
    }
  }, [bars, markers, label, height])

  if (bars.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded border border-gray-800 bg-gray-900 text-sm text-gray-500"
        style={{ height }}
      >
        no 1m market-cap minutes stored for this mint
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div ref={containerRef} className="w-full" />
      <p className="text-[10px] text-gray-500">
        {counted} mcap minutes · {markers.length} evaluations · {CHART_TZ} · red arrow ={' '}
        <span className="text-red-400">would_rug</span>, faint dot = a scored pass (the control half)
      </p>
    </div>
  )
}
