import { computeSocialScoreBoost } from '../social-scoring'
import {
  evaluateSocialGate,
  rollupToSocialSnapshot,
  socialSnapshotToFeatureFields,
  type SocialGateResult,
} from '../social-snapshot'
import type { SocialGateConfig, SocialSnapshot } from './types'
import { EMPTY_SOCIAL_SNAPSHOT } from './types'
import { fetchSocialRollup } from './db'

export type SocialContext = {
  snapshot: SocialSnapshot
  /** Token has Telegram/social activity within the 24h reference window. */
  isActive: boolean
  /** Strategy is evaluating a mint with active social context (same as isActive here). */
  overlap: boolean
  socialBoostScore: number
}

export function isSocialActive(
  snapshot: SocialSnapshot,
  atTime: Date = new Date(),
): boolean {
  if (snapshot.telegram_mention_count_30m > 0 || snapshot.telegram_mention_count_5m > 0) {
    return true
  }
  if (snapshot.has_smart_wallet_buy) return true
  const mins = snapshot.minutes_since_first_mention
  if (mins != null && mins >= 0 && mins <= 24 * 60) return true
  void atTime
  return false
}

export async function getSocialContext(
  mint: string,
  atTime: Date = new Date(),
): Promise<SocialContext> {
  const rollup = await fetchSocialRollup(mint)
  const snapshot = rollup ? rollupToSocialSnapshot(rollup, atTime) : { ...EMPTY_SOCIAL_SNAPSHOT }
  const active = isSocialActive(snapshot, atTime)
  const { boost } = computeSocialScoreBoost(snapshot)
  return {
    snapshot,
    isActive: active,
    overlap: active,
    socialBoostScore: active ? boost : 0,
  }
}

export function annotateEntryFeatures(
  features: Record<string, unknown>,
  ctx: SocialContext,
): Record<string, unknown> {
  const gmgnLiveBoost =
    typeof features.gmgn_live_boost_score === 'number' &&
    Number.isFinite(features.gmgn_live_boost_score)
      ? features.gmgn_live_boost_score
      : 0

  return {
    ...features,
    ...socialSnapshotToFeatureFields(ctx.snapshot),
    social_overlap: ctx.overlap,
    social_boost_score: ctx.socialBoostScore + gmgnLiveBoost,
  }
}

export function evaluateSocialGateFromContext(
  ctx: SocialContext,
  gate: SocialGateConfig | undefined,
  context: { tokenAddress: string; domain: string },
): SocialGateResult {
  return evaluateSocialGate(ctx.snapshot, gate, context)
}
