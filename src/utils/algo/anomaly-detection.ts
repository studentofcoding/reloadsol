export interface TokenMetrics {
  address: string;
  marketCap: number;
  volume24h: number;
  timestamp: number;
  priceChange24h: number;
}

export class ZScoreAnomalyDetector {
  private readonly windowSize: number = 50; // Rolling window for statistics
  private readonly threshold: number = 2.5; // Z-score threshold for anomalies

  calculateZScore(values: number[], currentValue: number): number {
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    return stdDev === 0 ? 0 : (currentValue - mean) / stdDev;
  }

  detectMcapAnomalies(historicalData: TokenMetrics[]): {
    anomalies: TokenMetrics[];
    zScores: number[];
  } {
    const anomalies: TokenMetrics[] = [];
    const zScores: number[] = [];

    for (let i = this.windowSize; i < historicalData.length; i++) {
      const window = historicalData.slice(i - this.windowSize, i);
      const mcapValues = window.map(d => d.marketCap);
      const currentMcap = historicalData[i].marketCap;

      const zScore = this.calculateZScore(mcapValues, currentMcap);
      zScores.push(zScore);

      if (Math.abs(zScore) > this.threshold) {
        anomalies.push({
          ...historicalData[i],
          zScore
        } as TokenMetrics & { zScore: number });
      }
    }

    return { anomalies, zScores };
  }

  /**
   * Detect anomalies for multiple tokens and return results as a Map
   * Expected by the data aggregation service
   */
  async detectAnomalies(tokens: TokenMetrics[]): Promise<Map<string, { zScore: number; anomalyType: 'positive' | 'negative' | 'neutral' }>> {
    const results = new Map<string, { zScore: number; anomalyType: 'positive' | 'negative' | 'neutral' }>();
    
    if (tokens.length < this.windowSize) {
      // Not enough data for meaningful analysis
      tokens.forEach(token => {
        results.set(token.address, {
          zScore: 0,
          anomalyType: 'neutral'
        });
      });
      return results;
    }

    // Group tokens by address to get historical data
    const tokenGroups = new Map<string, TokenMetrics[]>();
    tokens.forEach(token => {
      if (!tokenGroups.has(token.address)) {
        tokenGroups.set(token.address, []);
      }
      tokenGroups.get(token.address)!.push(token);
    });

    // Analyze each token group
    for (const [address, tokenHistory] of Array.from(tokenGroups)) {
      if (tokenHistory.length >= this.windowSize) {
        // Sort by timestamp
        tokenHistory.sort((a: TokenMetrics, b: TokenMetrics) => a.timestamp - b.timestamp);
        
        // Get the latest token data
        const latestToken = tokenHistory[tokenHistory.length - 1];
        const historicalValues = tokenHistory.slice(0, -1).map((t: TokenMetrics) => t.marketCap);
        
        const zScore = this.calculateZScore(historicalValues, latestToken.marketCap);
        
        let anomalyType: 'positive' | 'negative' | 'neutral' = 'neutral';
        if (zScore > this.threshold) {
          anomalyType = 'positive';
        } else if (zScore < -this.threshold) {
          anomalyType = 'negative';
        }
        
        results.set(address, { zScore, anomalyType });
      } else {
        // Not enough historical data
        results.set(address, {
          zScore: 0,
          anomalyType: 'neutral'
        });
      }
    }

    return results;
  }

  /**
   * Calculate rolling Z-scores for a single token's market cap history
   */
  calculateRollingZScores(marketCapHistory: number[]): number[] {
    const zScores: number[] = [];
    
    for (let i = this.windowSize; i < marketCapHistory.length; i++) {
      const window = marketCapHistory.slice(i - this.windowSize, i);
      const currentValue = marketCapHistory[i];
      const zScore = this.calculateZScore(window, currentValue);
      zScores.push(zScore);
    }
    
    return zScores;
  }
}