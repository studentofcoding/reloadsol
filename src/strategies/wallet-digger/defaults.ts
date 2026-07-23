export const ROSTER_TAG_DENYLIST = [
  'bundler',
  'dex_bot',
  'sniper',
  'rat_trader',
  'fresh_wallet',
] as const

export type RosterChain = 'sol' | 'robinhood'

export type RosterAgeMcapBands = {
  newMaxAgeHours: number
  newMinMcapUsd: number
  newMaxMcapUsd: number
  oldMinAgeHours: number
  oldMaxAgeHours: number
  oldMinMcapUsd: number
  oldMaxMcapUsd: number
}

export const DEFAULT_SOL_BANDS: RosterAgeMcapBands = {
  newMaxAgeHours: 24,
  newMinMcapUsd: 20_000,
  newMaxMcapUsd: 500_000,
  oldMinAgeHours: 24,
  oldMaxAgeHours: 168,
  oldMinMcapUsd: 1_000_000,
  oldMaxMcapUsd: 4_000_000,
}

export const DEFAULT_ROBINHOOD_BANDS: RosterAgeMcapBands = {
  newMaxAgeHours: 24,
  newMinMcapUsd: 100_000,
  newMaxMcapUsd: 1_000_000,
  oldMinAgeHours: 24,
  oldMaxAgeHours: 168,
  oldMinMcapUsd: 1_000_000,
  oldMaxMcapUsd: 5_000_000,
}

export const DEFAULT_ROSTER_CONFIG = {
  chains: ['sol', 'robinhood'] as RosterChain[],
  bands: {
    sol: { ...DEFAULT_SOL_BANDS },
    robinhood: { ...DEFAULT_ROBINHOOD_BANDS },
  },
  minWallets: 4,
  windowSec: 15 * 60,
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
  chains: RosterChain[]
  bands: {
    sol: RosterAgeMcapBands
    robinhood: RosterAgeMcapBands
  }
  minWallets: number
  windowSec: number
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

/** Legacy flat sol band fields that may still appear in stored strategy overrides. */
type LegacySolBandOverride = Partial<RosterAgeMcapBands>

export type AgeMcapBand = 'new' | 'old'

export type AgeMcapBandResult =
  | { ok: true; band: AgeMcapBand }
  | { ok: false; reason: string }

export function bandConfigForChain(
  cfg: RosterConcurrenceConfig,
  chain: RosterChain,
): RosterAgeMcapBands {
  return cfg.bands[chain] ?? cfg.bands.sol
}

/** Dual-band age×mcap gate — fail closed on null age/mcap. */
export function passAgeMcapBand(
  ageH: number | null,
  mcap: number | null,
  cfg: RosterAgeMcapBands,
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
  override?: (Partial<RosterConcurrenceConfig> & LegacySolBandOverride) | null,
): RosterConcurrenceConfig {
  const o = override ?? {}
  const legacySol: LegacySolBandOverride = {
    newMaxAgeHours: o.newMaxAgeHours,
    newMinMcapUsd: o.newMinMcapUsd,
    newMaxMcapUsd: o.newMaxMcapUsd,
    oldMinAgeHours: o.oldMinAgeHours,
    oldMaxAgeHours: o.oldMaxAgeHours,
    oldMinMcapUsd: o.oldMinMcapUsd,
    oldMaxMcapUsd: o.oldMaxMcapUsd,
  }
  const hasLegacySol = Object.values(legacySol).some((v) => v != null)

  const chains =
    o.chains?.length && o.chains.every((c) => c === 'sol' || c === 'robinhood')
      ? ([...new Set(o.chains)] as RosterChain[])
      : [...DEFAULT_ROSTER_CONFIG.chains]

  return {
    ...DEFAULT_ROSTER_CONFIG,
    ...o,
    chains,
    bands: {
      sol: {
        ...DEFAULT_SOL_BANDS,
        ...(hasLegacySol ? legacySol : {}),
        ...(o.bands?.sol ?? {}),
      },
      robinhood: {
        ...DEFAULT_ROBINHOOD_BANDS,
        ...(o.bands?.robinhood ?? {}),
      },
    },
    tagDenylist: o.tagDenylist?.length
      ? [...o.tagDenylist]
      : [...DEFAULT_ROSTER_CONFIG.tagDenylist],
  }
}
