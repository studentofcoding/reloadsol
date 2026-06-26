export interface TokenMetrics {
  address: string;
  marketCap: number;
  volume24h: number;
  timestamp: number;
  priceChange24h: number;
  /** Used for cross-sectional cohort mode */
  mcapGrowthPercent?: number;
}

export type AnomalyDetectMode = 'crossSection' | 'timeSeries';

export type AnomalyResult = {
  zScore: number | null;
  anomalyType: 'positive' | 'negative' | 'neutral';
  zScoreAvailable: boolean;
};

export class ZScoreAnomalyDetector {
  private readonly windowSize: number = 50; // Rolling window for time-series statistics
  private readonly threshold: number = 2.5; // Z-score threshold for anomalies
  private readonly crossSectionMinCohort: number = 3;

  calculateZScore(values: number[], currentValue: number): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    return stdDev === 0 ? 0 : (currentValue - mean) / stdDev;
  }

  detectCrossSectionAnomalies(
    tokens: TokenMetrics[],
  ): Map<string, AnomalyResult> {
    const results = new Map<string, AnomalyResult>();
    const cohort = tokens.filter(
      (t) => typeof t.mcapGrowthPercent === 'number' && Number.isFinite(t.mcapGrowthPercent),
    );

    if (cohort.length < this.crossSectionMinCohort) {
      tokens.forEach((token) => {
        results.set(token.address, {
          zScore: null,
          anomalyType: 'neutral',
          zScoreAvailable: false,
        });
      });
      return results;
    }

    for (const token of tokens) {
      const growth = token.mcapGrowthPercent;
      if (typeof growth !== 'number' || !Number.isFinite(growth)) {
        results.set(token.address, {
          zScore: null,
          anomalyType: 'neutral',
          zScoreAvailable: false,
        });
        continue;
      }
      const peerValues = cohort
        .filter((t) => t.address !== token.address)
        .map((t) => t.mcapGrowthPercent as number);
      if (peerValues.length < this.crossSectionMinCohort - 1) {
        results.set(token.address, {
          zScore: null,
          anomalyType: 'neutral',
          zScoreAvailable: false,
        });
        continue;
      }
      const zScore = this.calculateZScore(peerValues, growth);
      let anomalyType: 'positive' | 'negative' | 'neutral' = 'neutral';
      if (zScore > this.threshold) anomalyType = 'positive';
      else if (zScore < -this.threshold) anomalyType = 'negative';
      results.set(token.address, {
        zScore,
        anomalyType,
        zScoreAvailable: true,
      });
    }
    return results;
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

  async detectAnomalies(
    tokens: TokenMetrics[],
    options?: { mode?: AnomalyDetectMode },
  ): Promise<Map<string, AnomalyResult>> {
    const mode = options?.mode ?? 'timeSeries';

    if (mode === 'crossSection') {
      return this.detectCrossSectionAnomalies(tokens);
    }

    const results = new Map<string, AnomalyResult>();

    if (tokens.length < this.windowSize) {
      tokens.forEach((token) => {
        results.set(token.address, {
          zScore: null,
          anomalyType: 'neutral',
          zScoreAvailable: false,
        });
      });
      return results;
    }

    const tokenGroups = new Map<string, TokenMetrics[]>();
    tokens.forEach(token => {
      if (!tokenGroups.has(token.address)) {
        tokenGroups.set(token.address, []);
      }
      tokenGroups.get(token.address)!.push(token);
    });

    for (const [address, tokenHistory] of Array.from(tokenGroups)) {
      if (tokenHistory.length >= this.windowSize) {
        tokenHistory.sort((a: TokenMetrics, b: TokenMetrics) => a.timestamp - b.timestamp);

        const latestToken = tokenHistory[tokenHistory.length - 1];
        const historicalValues = tokenHistory.slice(0, -1).map((t: TokenMetrics) => t.marketCap);

        const zScore = this.calculateZScore(historicalValues, latestToken.marketCap);

        let anomalyType: 'positive' | 'negative' | 'neutral' = 'neutral';
        if (zScore > this.threshold) {
          anomalyType = 'positive';
        } else if (zScore < -this.threshold) {
          anomalyType = 'negative';
        }

        results.set(address, { zScore, anomalyType, zScoreAvailable: true });
      } else {
        results.set(address, {
          zScore: null,
          anomalyType: 'neutral',
          zScoreAvailable: false,
        });
      }
    }

    return results;
  }

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
