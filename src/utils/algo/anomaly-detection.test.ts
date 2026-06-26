import { describe, expect, it } from 'vitest'
import { ZScoreAnomalyDetector } from './anomaly-detection'

describe('ZScoreAnomalyDetector crossSection', () => {
  it('flags outlier growth in cohort of 5', () => {
    const detector = new ZScoreAnomalyDetector()
    const tokens = [
      { address: 'a', marketCap: 100, volume24h: 0, timestamp: 0, priceChange24h: 0, mcapGrowthPercent: 10 },
      { address: 'b', marketCap: 100, volume24h: 0, timestamp: 0, priceChange24h: 0, mcapGrowthPercent: 12 },
      { address: 'c', marketCap: 100, volume24h: 0, timestamp: 0, priceChange24h: 0, mcapGrowthPercent: 8 },
      { address: 'd', marketCap: 100, volume24h: 0, timestamp: 0, priceChange24h: 0, mcapGrowthPercent: 11 },
      { address: 'e', marketCap: 100, volume24h: 0, timestamp: 0, priceChange24h: 0, mcapGrowthPercent: 200 },
    ]
    const results = detector.detectCrossSectionAnomalies(tokens)
    const outlier = results.get('e')
    expect(outlier?.zScoreAvailable).toBe(true)
    expect(outlier?.anomalyType).toBe('positive')
    expect(outlier?.zScore).not.toBeNull()
  })

  it('returns unavailable when cohort too small', () => {
    const detector = new ZScoreAnomalyDetector()
    const tokens = [
      { address: 'a', marketCap: 100, volume24h: 0, timestamp: 0, priceChange24h: 0, mcapGrowthPercent: 10 },
      { address: 'b', marketCap: 100, volume24h: 0, timestamp: 0, priceChange24h: 0, mcapGrowthPercent: 12 },
    ]
    const results = detector.detectCrossSectionAnomalies(tokens)
    expect(results.get('a')?.zScoreAvailable).toBe(false)
    expect(results.get('a')?.zScore).toBeNull()
  })
})
