import type { SocialSnapshot } from './social/types'
import type { SignalsScoringWeights } from './types'

export type SocialScoringWeights = {
  mentionTier1: number
  mentionTier2: number
  mentionTier3: number
  uniqueChannelBonus: number
  smartWalletBuyBonus: number
  tier1WalletBonus: number
  alreadyPumpedPenalty: number
}

export const DEFAULT_SOCIAL_SCORING_WEIGHTS: SocialScoringWeights = {
  mentionTier1: 8,
  mentionTier2: 15,
  mentionTier3: 25,
  uniqueChannelBonus: 10,
  smartWalletBuyBonus: 30,
  tier1WalletBonus: 15,
  alreadyPumpedPenalty: 20,
}

export function computeSocialScoreBoost(
  snapshot: SocialSnapshot,
  weights: SocialScoringWeights = DEFAULT_SOCIAL_SCORING_WEIGHTS,
): { boost: number; notes: string[] } {
  const notes: string[] = []
  let boost = 0

  const mentions = snapshot.telegram_mention_count_30m
  if (mentions >= 4) {
    boost += weights.mentionTier3
    notes.push(`mentions_30m>=4 (+${weights.mentionTier3})`)
  } else if (mentions >= 2) {
    boost += weights.mentionTier2
    notes.push(`mentions_30m>=2 (+${weights.mentionTier2})`)
  } else if (mentions >= 1) {
    boost += weights.mentionTier1
    notes.push(`mentions_30m>=1 (+${weights.mentionTier1})`)
  }

  if (snapshot.telegram_unique_channels_30m >= 2) {
    boost += weights.uniqueChannelBonus
    notes.push(`unique_channels>=2 (+${weights.uniqueChannelBonus})`)
  }

  if (snapshot.has_smart_wallet_buy) {
    boost += weights.smartWalletBuyBonus
    notes.push(`smart_wallet_buy (+${weights.smartWalletBuyBonus})`)
    if (snapshot.smart_wallet_buy_sol_1h >= 1) {
      boost += weights.tier1WalletBonus
      notes.push(`smart_wallet_sol>=1 (+${weights.tier1WalletBonus})`)
    }
  }

  return { boost, notes }
}

/** Extend signals scoring weights type for registry defaults (optional social block). */
export type ExtendedSignalsScoringWeights = SignalsScoringWeights & {
  social?: Partial<SocialScoringWeights>
}

export function applySocialBoostToScore(
  baseScore: number,
  snapshot: SocialSnapshot,
  socialWeights?: Partial<SocialScoringWeights>,
): { score: number; socialBoost: number; socialNotes: string[] } {
  const { boost, notes } = computeSocialScoreBoost(snapshot, {
    ...DEFAULT_SOCIAL_SCORING_WEIGHTS,
    ...socialWeights,
  })
  return {
    score: baseScore + boost,
    socialBoost: boost,
    socialNotes: notes,
  }
}

export function checkAlreadyPumped(
  netVolume1m: number | null | undefined,
  mcp: number | null | undefined,
  penalty = DEFAULT_SOCIAL_SCORING_WEIGHTS.alreadyPumpedPenalty,
): { pumped: boolean; penalty: number } {
  if (
    netVolume1m == null ||
    mcp == null ||
    !Number.isFinite(netVolume1m) ||
    !Number.isFinite(mcp) ||
    mcp <= 0
  ) {
    return { pumped: false, penalty: 0 }
  }
  if (netVolume1m > 0.35 * mcp) {
    return { pumped: true, penalty }
  }
  return { pumped: false, penalty: 0 }
}
