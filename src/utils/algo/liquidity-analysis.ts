interface LiquidityMetrics {
  totalLiquidity: number;
  bidAskSpread: number;
  volumeToMcapRatio: number;
  uniqueHolders: number;
  largeTransactionCount: number;
}

class LiquidityFilter {
  private readonly minLiquidityThreshold = 50000; // $50k minimum liquidity
  private readonly maxSpreadThreshold = 0.05; // 5% max bid-ask spread
  private readonly minVolumeRatio = 0.1; // 10% volume to mcap ratio
  
  isLegitimateToken(metrics: LiquidityMetrics, tokenData: TokenMetrics): boolean {
    const liquidityCheck = metrics.totalLiquidity >= this.minLiquidityThreshold;
    const spreadCheck = metrics.bidAskSpread <= this.maxSpreadThreshold;
    const volumeCheck = metrics.volumeToMcapRatio >= this.minVolumeRatio;
    const holderDistribution = this.analyzeHolderDistribution(metrics);
    
    return liquidityCheck && spreadCheck && volumeCheck && holderDistribution;
  }
  
  private analyzeHolderDistribution(metrics: LiquidityMetrics): boolean {
    // Check for healthy holder distribution (not concentrated in few wallets)
    const minHolders = 100;
    const healthyTransactionPattern = metrics.largeTransactionCount < metrics.uniqueHolders * 0.1;
    
    return metrics.uniqueHolders >= minHolders && healthyTransactionPattern;
  }
  
  calculateLiquidityScore(metrics: LiquidityMetrics): number {
    const liquidityScore = Math.min(metrics.totalLiquidity / 1000000, 1); // Normalize to $1M
    const spreadScore = Math.max(0, 1 - metrics.bidAskSpread / 0.1); // Penalize wide spreads
    const volumeScore = Math.min(metrics.volumeToMcapRatio / 0.5, 1); // Normalize to 50%
    const holderScore = Math.min(metrics.uniqueHolders / 1000, 1); // Normalize to 1000 holders
    
    return (liquidityScore + spreadScore + volumeScore + holderScore) / 4;
  }
}