class CorrelationAnalyzer {
  calculatePearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    const sumX = x.slice(0, n).reduce((sum, val) => sum + val, 0);
    const sumY = y.slice(0, n).reduce((sum, val) => sum + val, 0);
    const sumXY = x.slice(0, n).reduce((sum, val, i) => sum + val * y[i], 0);
    const sumX2 = x.slice(0, n).reduce((sum, val) => sum + val * val, 0);
    const sumY2 = y.slice(0, n).reduce((sum, val) => sum + val * val, 0);
    
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    
    return denominator === 0 ? 0 : numerator / denominator;
  }
  
  analyzeTokenCorrelations(tokenData: TokenMetrics[], solPrices: number[]): {
    solCorrelation: number;
    beta: number;
    independenceScore: number;
  } {
    const tokenReturns = this.calculateReturns(tokenData.map(d => d.mcap));
    const solReturns = this.calculateReturns(solPrices);
    
    const correlation = this.calculatePearsonCorrelation(tokenReturns, solReturns);
    const beta = this.calculateBeta(tokenReturns, solReturns);
    const independenceScore = 1 - Math.abs(correlation);
    
    return { solCorrelation: correlation, beta, independenceScore };
  }
  
  private calculateReturns(prices: number[]): number[] {
    return prices.slice(1).map((price, i) => (price - prices[i]) / prices[i]);
  }
  
  private calculateBeta(tokenReturns: number[], marketReturns: number[]): number {
    const covariance = this.calculateCovariance(tokenReturns, marketReturns);
    const marketVariance = this.calculateVariance(marketReturns);
    return marketVariance === 0 ? 0 : covariance / marketVariance;
  }
  
  private calculateCovariance(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    const meanX = x.slice(0, n).reduce((sum, val) => sum + val, 0) / n;
    const meanY = y.slice(0, n).reduce((sum, val) => sum + val, 0) / n;
    
    return x.slice(0, n).reduce((sum, val, i) => sum + (val - meanX) * (y[i] - meanY), 0) / n;
  }
  
  private calculateVariance(values: number[]): number {
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  }
}