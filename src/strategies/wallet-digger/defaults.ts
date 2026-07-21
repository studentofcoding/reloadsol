export const ROSTER_TAG_DENYLIST = [
  'bundler',
  'dex_bot',
  'sniper',
  'rat_trader',
  'fresh_wallet',
] as const

export const DEFAULT_ROSTER_CONFIG = {
  minWallets: 4,
  windowSec: 15 * 60,
  maxTokenAgeHours: 6,
  minMcapUsd: 20_000,
  maxMcapUsd: 2_000_000,
  digMarketCap: 25,
  rosterCap: 150,
  minRunnerHits: 2,
  minWinrate: 0.4,
  minBuyCount: 10,
  minPnl: 1.0,
  wonOutcomesHours: 48,
  tagDenylist: [...ROSTER_TAG_DENYLIST] as string[],
}

export type RosterConcurrenceConfig = {
  minWallets: number
  windowSec: number
  maxTokenAgeHours: number
  minMcapUsd: number
  maxMcapUsd: number
  digMarketCap: number
  rosterCap: number
  minRunnerHits: number
  minWinrate: number
  minBuyCount: number
  minPnl: number
  wonOutcomesHours: number
  tagDenylist: string[]
}

export function mergeRosterConfig(
  override?: Partial<RosterConcurrenceConfig> | null,
): RosterConcurrenceConfig {
  return {
    ...DEFAULT_ROSTER_CONFIG,
    ...(override ?? {}),
    tagDenylist: override?.tagDenylist?.length
      ? [...override.tagDenylist]
      : [...DEFAULT_ROSTER_CONFIG.tagDenylist],
  }
}
