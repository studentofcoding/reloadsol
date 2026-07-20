'use client'

export type MiniOhlcBar = {
  t: number
  o: number
  h: number
  l: number
  c: number
  v?: number
}

/** Tiny SVG candlesticks — same paint as Freeview OHLC rail. */
export default function MiniOhlcCandles({
  bars,
  trip = false,
  className = 'h-16 w-full',
  emptyLabel = 'No OHLC',
}: {
  bars: MiniOhlcBar[]
  trip?: boolean
  className?: string
  emptyLabel?: string
}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center text-[9px] text-gray-500">
        {emptyLabel}
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
      className={className}
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
          <g key={`${b.t}-${i}`}>
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
