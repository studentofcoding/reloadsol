import { describe, expect, it } from 'vitest'
import type { TokenMapDomain } from '@/strategies/token-map-types'
import {
  buildTidiedMarkers,
  candleIntervalSec,
  collapseMarkers,
  type ChartMarker,
} from '@/strategies/token-map-chart-markers'

describe('candleIntervalSec', () => {
  it('returns median gap', () => {
    expect(
      candleIntervalSec([
        { time: 100, open: 1, high: 1, low: 1, close: 1 },
        { time: 160, open: 1, high: 1, low: 1, close: 1 },
        { time: 220, open: 1, high: 1, low: 1, close: 1 },
      ]),
    ).toBe(60)
  })
})

describe('collapseMarkers', () => {
  it('keeps one open, close, and clustered signal per bucket', () => {
    // All times in the same 60s bucket [60, 120)
    const markers: ChartMarker[] = [
      {
        time: 100,
        role: 'signal',
        shape: 'circle',
        position: 'inBar',
        color: '#facc15',
        size: 1,
      },
      {
        time: 110,
        role: 'signal',
        shape: 'circle',
        position: 'inBar',
        color: '#facc15',
        size: 1,
      },
      {
        time: 115,
        role: 'signal',
        shape: 'circle',
        position: 'inBar',
        color: '#60a5fa',
        size: 1,
      },
      {
        time: 105,
        role: 'open',
        shape: 'arrowUp',
        position: 'belowBar',
        color: '#34d399',
        size: 1,
        text: 'in foo',
      },
      {
        time: 118,
        role: 'close',
        shape: 'square',
        position: 'aboveBar',
        color: '#f87171',
        size: 1,
        text: '1.0%',
      },
    ]
    const out = collapseMarkers(markers, 60)
    expect(out).toHaveLength(3)
    const open = out.find((m) => m.role === 'open')
    const close = out.find((m) => m.role === 'close')
    const signal = out.find((m) => m.role === 'signal')
    expect(open?.text).toBe('in foo')
    expect(close?.text).toBe('1.0%')
    expect(signal?.text).toBe('×3')
    expect(signal?.position).toBe('inBar')
  })
})

describe('buildTidiedMarkers', () => {
  it('omits long social labels', () => {
    const enabled = new Set<TokenMapDomain>(['gmgn', 'signals'])
    const out = buildTidiedMarkers({
      enabled,
      intervalSec: 60,
      activities: [
        {
          id: '1',
          domain: 'gmgn',
          kind: 'gmgn_hot',
          title: 'GMGN hot activity',
          occurredAt: '2026-07-19T12:00:00.000Z',
        },
        {
          id: '2',
          domain: 'gmgn',
          kind: 'social_event',
          title: 'wallet buy - gmgn_smart_money',
          occurredAt: '2026-07-19T12:00:30.000Z',
        },
        {
          id: '3',
          domain: 'signals',
          kind: 'sim_open',
          title: 'Sim open · signals_sell_over',
          occurredAt: '2026-07-19T12:00:10.000Z',
        },
      ],
      outcomes: [],
    })
    const signal = out.find((m) => m.role === 'signal')
    const open = out.find((m) => m.role === 'open')
    expect(signal?.text).toBe('×2')
    expect(open?.text).toBe('signals_sel…')
  })
})
