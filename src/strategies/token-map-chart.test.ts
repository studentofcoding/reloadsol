import { describe, expect, it } from 'vitest'
import { fetchTokenOhlc } from '@/strategies/token-map-chart'

describe('fetchTokenOhlc', () => {
  it('returns empty candles until an OHLC source is wired', async () => {
    const result = await fetchTokenOhlc({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      hours: 24,
    })
    expect(result.candles).toEqual([])
    expect(result.source).toBe('none')
  })
})
