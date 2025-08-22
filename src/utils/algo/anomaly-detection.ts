interface TokenMetrics {
  address: string;
  mcap: number;
  volume24h: number;
  timestamp: number;
  priceChange24h: number;
}

class ZScoreAnomalyDetector {
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
      const mcapValues = window.map(d => d.mcap);
      const currentMcap = historicalData[i].mcap;

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
}