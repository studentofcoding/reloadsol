/**
 * Utility for calculating weighted position sizes based on market cap.
 * 
 * Strategy:
 * - Tokens < $50k MCap: Weight 0.35 (Lower confidence/Higher risk)
 * - Tokens > $100k MCap: Weight 0.65 (Higher confidence/Stability)
 * - Tokens between $50k-$100k: Weight 0.50 (Medium) - Added for completeness
 */

export interface TokenWeightInput {
  address: string;
  marketCap: number; // in USD
}

export interface WeightedAllocation {
  address: string;
  weight: number;
  solAmount: number;
  percentage: number;
}

export function calculateWeightedDistribution(
  totalSol: number,
  tokens: TokenWeightInput[]
): WeightedAllocation[] {
  if (tokens.length === 0) return [];
  if (totalSol <= 0) return [];

  // 1. Calculate raw scores based on strategy
  const scores = tokens.map(t => {
    let score = 0.5; // Default
    if (t.marketCap < 50_000) {
      score = 0.35;
    } else if (t.marketCap > 100_000) {
      score = 0.65;
    } else {
      // Linear interpolation between 50k and 100k? Or just flat 0.5?
      // User didn't specify, but 0.5 seems safe middle ground.
      score = 0.5;
    }
    return { ...t, score };
  });

  // 2. Sum total score to normalize
  const totalScore = scores.reduce((sum, t) => sum + t.score, 0);

  // 3. Distribute SOL
  return scores.map(t => {
    const share = t.score / totalScore;
    const amount = totalSol * share;

    return {
      address: t.address,
      weight: t.score,
      solAmount: Number(amount.toFixed(4)), // Round to 4 decimals for safety
      percentage: Number((share * 100).toFixed(2))
    };
  });
}
