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
  newMaxAgeHours: 24,
  newMinMcapUsd: 20_000,
  newMaxMcapUsd: 500_000,
  oldMinAgeHours: 24,
  oldMaxAgeHours: 168,
  oldMinMcapUsd: 1_000_000,
  oldMaxMcapUsd: 4_000_000,
  minRunnerHitsSum: 8,
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
  newMaxAgeHours: number
  newMinMcapUsd: number
  newMaxMcapUsd: number
  oldMinAgeHours: number
  oldMaxAgeHours: number
  oldMinMcapUsd: number
  oldMaxMcapUsd: number
  minRunnerHitsSum: number
  digMarketCap: number
  rosterCap: number
  minRunnerHits: number
  minWinrate: number
  minBuyCount: number
  minPnl: number
  wonOutcomesHours: number
  tagDenylist: string[]
}

export type AgeMcapBand = 'new' | 'old'

export type AgeMcapBandResult =
  | { ok: true; band: AgeMcapBand }
  | { ok: false; reason: string }

/** Dual-band age×mcap gate — fail closed on null age/mcap. */
export function passAgeMcapBand(
  ageH: number | null,
  mcap: number | null,
  cfg: Pick<
    RosterConcurrenceConfig,
    | 'newMaxAgeHours'
    | 'newMinMcapUsd'
    | 'newMaxMcapUsd'
    | 'oldMinAgeHours'
    | 'oldMaxAgeHours'
    | 'oldMinMcapUsd'
    | 'oldMaxMcapUsd'
  >,
): AgeMcapBandResult {
  if (ageH == null) return { ok: false, reason: 'unknown age' }
  if (mcap == null) return { ok: false, reason: 'unknown mcap' }
  if (!Number.isFinite(ageH) || ageH < 0) return { ok: false, reason: 'invalid age' }
  if (!Number.isFinite(mcap) || mcap < 0) return { ok: false, reason: 'invalid mcap' }

  if (ageH < cfg.newMaxAgeHours) {
    if (mcap >= cfg.newMinMcapUsd && mcap <= cfg.newMaxMcapUsd) {
      return { ok: true, band: 'new' }
    }
    return {
      ok: false,
      reason: `new-band mcap ${Math.round(mcap)} outside ${cfg.newMinMcapUsd}-${cfg.newMaxMcapUsd}`,
    }
  }

  if (ageH >= cfg.oldMinAgeHours && ageH <= cfg.oldMaxAgeHours) {
    if (mcap >= cfg.oldMinMcapUsd && mcap <= cfg.oldMaxMcapUsd) {
      return { ok: true, band: 'old' }
    }
    return {
      ok: false,
      reason: `old-band mcap ${Math.round(mcap)} outside ${cfg.oldMinMcapUsd}-${cfg.oldMaxMcapUsd}`,
    }
  }

  return {
    ok: false,
    reason: `age ${ageH.toFixed(1)}h outside new(<${cfg.newMaxAgeHours}h) and old(${cfg.oldMinAgeHours}-${cfg.oldMaxAgeHours}h)`,
  }
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
