import type { SocialGateConfig, SocialSnapshot } from './social/types'
import { EMPTY_SOCIAL_SNAPSHOT } from './social/types'
import { SOCIAL_CONFIG } from '@/utils/social/config'

export type { SocialSnapshot, SocialGateConfig } from './social/types'
export { EMPTY_SOCIAL_SNAPSHOT } from './social/types'

function minutesSince(iso: string | null | undefined, atTime: Date): number | null {
  if (!iso) return null
  const ms = atTime.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.round(ms / (60 * 1000))
}

export function rollupToSocialSnapshot(
  rollup: {
    first_seen_at: string | null
    mention_count_5m: number
    mention_count_30m: number
    unique_channel_count_30m: number
    smart_wallet_buy_count_1h: number
    smart_wallet_buy_sol_1h: number
    top_source: string | null
  } | null,
  atTime: Date = new Date(),
): SocialSnapshot {
  if (!rollup) return { ...EMPTY_SOCIAL_SNAPSHOT }

  const buyCount = Number(rollup.smart_wallet_buy_count_1h) || 0
  return {
    telegram_mention_count_5m: Number(rollup.mention_count_5m) || 0,
    telegram_mention_count_30m: Number(rollup.mention_count_30m) || 0,
    telegram_unique_channels_30m: Number(rollup.unique_channel_count_30m) || 0,
    minutes_since_first_mention: minutesSince(rollup.first_seen_at, atTime),
    smart_wallet_buy_count_1h: buyCount,
    smart_wallet_buy_sol_1h: Number(rollup.smart_wallet_buy_sol_1h) || 0,
    telegram_top_source: rollup.top_source,
    has_smart_wallet_buy: buyCount > 0,
  }
}

export function socialSnapshotToFeatureFields(
  snapshot: SocialSnapshot,
): Record<string, unknown> {
  return {
    telegram_mention_count_5m: snapshot.telegram_mention_count_5m,
    telegram_mention_count_30m: snapshot.telegram_mention_count_30m,
    telegram_unique_channels_30m: snapshot.telegram_unique_channels_30m,
    minutes_since_first_mention: snapshot.minutes_since_first_mention,
    smart_wallet_buy_count_1h: snapshot.smart_wallet_buy_count_1h,
    smart_wallet_buy_sol_1h: snapshot.smart_wallet_buy_sol_1h,
    telegram_top_source: snapshot.telegram_top_source,
    has_smart_wallet_buy: snapshot.has_smart_wallet_buy,
  }
}

export type SocialGateResult = {
  passed: boolean
  reason: string | null
  snapshot: SocialSnapshot
}

export function evaluateSocialGate(
  snapshot: SocialSnapshot,
  gate: SocialGateConfig | undefined,
  context: { tokenAddress: string; domain: string },
): SocialGateResult {
  if (!gate) return { passed: true, reason: null, snapshot }

  const minMentions = gate.socialMinMentions30m ?? 0
  if (minMentions > 0 && snapshot.telegram_mention_count_30m < minMentions) {
    const reason = `social_min_mentions_30m (${snapshot.telegram_mention_count_30m} < ${minMentions})`
    if (SOCIAL_CONFIG.shadowMode) {
      console.info('[social-gate:shadow]', { ...context, reason })
      return { passed: true, reason, snapshot }
    }
    return { passed: false, reason, snapshot }
  }

  if (gate.socialRequireSmartWalletBuy && !snapshot.has_smart_wallet_buy) {
    const reason = 'social_require_smart_wallet_buy'
    if (SOCIAL_CONFIG.shadowMode) {
      console.info('[social-gate:shadow]', { ...context, reason })
      return { passed: true, reason, snapshot }
    }
    return { passed: false, reason, snapshot }
  }

  const maxMinutes = gate.socialMaxMinutesSinceFirstMention
  if (
    maxMinutes != null &&
    maxMinutes > 0 &&
    snapshot.minutes_since_first_mention != null &&
    snapshot.minutes_since_first_mention > maxMinutes
  ) {
    const reason = `social_stale_mention (${snapshot.minutes_since_first_mention}m > ${maxMinutes}m)`
    if (SOCIAL_CONFIG.shadowMode) {
      console.info('[social-gate:shadow]', { ...context, reason })
      return { passed: true, reason, snapshot }
    }
    return { passed: false, reason, snapshot }
  }

  return { passed: true, reason: null, snapshot }
}
