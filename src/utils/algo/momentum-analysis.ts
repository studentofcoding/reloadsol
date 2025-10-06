interface McapTrackingData {
  token_address: string
  token_symbol: string
  current_mcap: number
  first_mcap: number
  mcap_growth_percent: number
  first_seen_at: string
  last_updated_at: string
}

interface MomentumSignal {
  token_address: string
  signal_type: 'bullish_breakout' | 'bearish_breakout' | 'momentum_acceleration' | 'momentum_deceleration'
  strength: number
  confidence: number
  timestamp: string
  mcap_delta: number
  volume_factor?: number
}

class EnhancedMomentumAnalyzer {
  private readonly fastEMA: number = 12
  private readonly slowEMA: number = 26
  private readonly signalEMA: number = 9
  private readonly momentumThreshold: number = 0.15 // 15% momentum threshold

  // Convert MCap tracking data to time series
  convertToTimeSeries(data: McapTrackingData[]): {
    address: string
    mcapSeries: number[]
    timestamps: string[]
    growthRates: number[]
  }[] {
    const groupedByToken = data.reduce((acc, item) => {
      if (!acc[item.token_address]) {
        acc[item.token_address] = []
      }
      acc[item.token_address].push(item)
      return acc
    }, {} as Record<string, McapTrackingData[]>)

    return Object.entries(groupedByToken).map(([address, tokenData]) => {
      const sorted = tokenData.sort((a, b) =>
        new Date(a.first_seen_at).getTime() - new Date(b.first_seen_at).getTime()
      )

      return {
        address,
        mcapSeries: sorted.map(d => d.current_mcap),
        timestamps: sorted.map(d => d.last_updated_at),
        growthRates: sorted.map(d => d.mcap_growth_percent)
      }
    })
  }

  // Enhanced MACD calculation with volume weighting
  calculateEnhancedMACD(mcapData: number[], volumeData?: number[]): {
    macd: number[]
    signal: number[]
    histogram: number[]
    momentum: number[]
  } {
    const fastEMA = this.calculateEMA(mcapData, this.fastEMA)
    const slowEMA = this.calculateEMA(mcapData, this.slowEMA)

    const macd = fastEMA.map((fast, i) => fast - slowEMA[i])
    const signal = this.calculateEMA(macd, this.signalEMA)
    const histogram = macd.map((m, i) => m - signal[i])

    // Calculate momentum acceleration
    const momentum = histogram.map((h, i) => {
      if (i === 0) return 0
      return h - histogram[i - 1]
    })

    return { macd, signal, histogram, momentum }
  }

  // Detect momentum signals with enhanced logic
  detectMomentumSignals(data: McapTrackingData[]): MomentumSignal[] {
    const signals: MomentumSignal[] = []
    const timeSeries = this.convertToTimeSeries(data)

    timeSeries.forEach(({ address, mcapSeries, timestamps, growthRates }) => {
      if (mcapSeries.length < this.slowEMA) return

      const { macd, signal, histogram, momentum } = this.calculateEnhancedMACD(mcapSeries)

      // Detect various momentum patterns
      for (let i = 2; i < histogram.length; i++) {
        const currentHist = histogram[i]
        const prevHist = histogram[i - 1]
        const currentMomentum = momentum[i]
        const mcapDelta = mcapSeries[i] - mcapSeries[i - 1]

        // Bullish breakout: MACD crosses above signal with acceleration
        if (currentHist > 0 && prevHist <= 0 && currentMomentum > 0) {
          signals.push({
            token_address: address,
            signal_type: 'bullish_breakout',
            strength: Math.abs(currentHist),
            confidence: Math.min(Math.abs(currentMomentum) * 10, 1),
            timestamp: timestamps[i],
            mcap_delta: mcapDelta
          })
        }

        // Bearish breakout: MACD crosses below signal with deceleration
        if (currentHist < 0 && prevHist >= 0 && currentMomentum < 0) {
          signals.push({
            token_address: address,
            signal_type: 'bearish_breakout',
            strength: Math.abs(currentHist),
            confidence: Math.min(Math.abs(currentMomentum) * 10, 1),
            timestamp: timestamps[i],
            mcap_delta: mcapDelta
          })
        }

        // Momentum acceleration: Strong positive momentum increase
        if (currentMomentum > this.momentumThreshold && growthRates[i] > 50) {
          signals.push({
            token_address: address,
            signal_type: 'momentum_acceleration',
            strength: currentMomentum,
            confidence: Math.min(growthRates[i] / 100, 1),
            timestamp: timestamps[i],
            mcap_delta: mcapDelta
          })
        }
      }
    })

    return signals.sort((a, b) => b.confidence - a.confidence)
  }

  // Analyze market cap momentum with delta analysis
  analyzeMcapMomentum(data: McapTrackingData[]): {
    strongMomentum: McapTrackingData[]
    weakMomentum: McapTrackingData[]
    averageMomentum: number
    momentumDistribution: Record<string, number>
  } {
    const momentumRanges = {
      'explosive (>1000%)': 0,
      'very_strong (500-1000%)': 0,
      'strong (200-500%)': 0,
      'moderate (50-200%)': 0,
      'weak (0-50%)': 0,
      'negative (<0%)': 0
    }

    const strongMomentum = data.filter(token => {
      const growth = token.mcap_growth_percent
      if (growth > 1000) momentumRanges['explosive (>1000%)']++
      else if (growth > 500) momentumRanges['very_strong (500-1000%)']++
      else if (growth > 200) momentumRanges['strong (200-500%)']++
      else if (growth > 50) momentumRanges['moderate (50-200%)']++
      else if (growth > 0) momentumRanges['weak (0-50%)']++
      else momentumRanges['negative (<0%)']++

      return growth > 200 // Strong momentum threshold
    })

    const weakMomentum = data.filter(token =>
      token.mcap_growth_percent < 50 && token.mcap_growth_percent > 0
    )

    const averageMomentum = data.length > 0
      ? data.reduce((sum, token) => sum + token.mcap_growth_percent, 0) / data.length
      : 0

    return {
      strongMomentum,
      weakMomentum,
      averageMomentum,
      momentumDistribution: momentumRanges
    }
  }

  private calculateEMA(values: number[], period: number): number[] {
    const ema: number[] = []
    const multiplier = 2 / (period + 1)

    ema[0] = values[0]

    for (let i = 1; i < values.length; i++) {
      ema[i] = (values[i] * multiplier) + (ema[i - 1] * (1 - multiplier))
    }

    return ema
  }
}

export { EnhancedMomentumAnalyzer, type MomentumSignal, type McapTrackingData }