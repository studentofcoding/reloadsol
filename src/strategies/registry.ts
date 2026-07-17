import type { TokenFilterConfig, TrendingBotStrategy } from './types'

export const DEFAULT_FILTER_CONFIG: TokenFilterConfig = {
  enabled: true,
  mcap: { min: 350_000, max: 3_000_000 },
  priceChange5m: { max: -40.0 },
  priceChange1h: { max: 100.0 },
  priceChange6h: { max: 60.0 },
  organicScore: { min: 70 },
  topHoldersPercentage: { max: 25 },
  requireCompleteData: true,
  checkManualTradingHistory: true,
}

export const TRENDING_BOT_STRATEGIES: Record<string, TrendingBotStrategy> = {
  att: {
    id: 'att',
    name: 'Attention Strategy',
    description: 'Original aggressive trading strategy',
    is_active: true,
    take_profit_levels: {
      tp1_percentage: 45,
      tp1_sell_percentage: 90,
      tp2_percentage: 100,
      tp3_percentage: 30,
      tp3_enabled: false,
    },
    buy_amount_sol: 0.035,
    priority_fee_lamports: 1_000_000,
    stop_loss_percentage: -35,
    max_hold_hours: 24,
    conditions: {
      min_market_cap: 200_000,
      max_market_cap: 5_000_000,
      min_organic_score: 60,
      max_risk_level: 'high',
    },
    filtering: {
      enabled: true,
      mcap: { min: 200_000, max: 5_000_000 },
      priceChange5m: { max: -50.0 },
      priceChange1h: { max: 150.0 },
      priceChange6h: { max: 80.0 },
      organicScore: { min: 60 },
      topHoldersPercentage: { max: 30 },
      requireCompleteData: true,
      checkManualTradingHistory: true,
    },
  },
  lowcap_moonbag: {
    id: 'lowcap_moonbag',
    name: 'low cap potentail moonback',
    description: 'Lower risk, steady gains approach',
    is_active: true,
    take_profit_levels: {
      tp1_percentage: 200,
      tp1_sell_percentage: 90,
      tp2_percentage: 400,
      tp3_percentage: 600,
      tp3_enabled: true,
    },
    buy_amount_sol: 0.008,
    priority_fee_lamports: 1_000_000,
    stop_loss_percentage: -30,
    max_hold_hours: 12,
    conditions: {
      min_market_cap: 35_000,
      max_market_cap: 90_000,
      min_organic_score: 0,
      max_risk_level: 'low',
    },
    filtering: {
      enabled: true,
      mcap: { min: 35_000, max: 90_000 },
      priceChange5m: { max: -25.0 },
      priceChange1h: { max: 600.0 },
      priceChange6h: { max: 600.0 },
      organicScore: { min: 0 },
      topHoldersPercentage: { max: 25 },
      requireCompleteData: true,
      checkManualTradingHistory: true,
    },
  },
  scalper: {
    id: 'scalper',
    name: 'Scalping Strategy',
    description: 'Quick profits, fast exits',
    is_active: false,
    take_profit_levels: {
      tp1_percentage: 15,
      tp1_sell_percentage: 90,
      tp2_percentage: 25,
      tp3_percentage: 40,
      tp3_enabled: true,
    },
    buy_amount_sol: 0.008,
    priority_fee_lamports: 1_000_000,
    stop_loss_percentage: -15,
    max_hold_hours: 6,
    conditions: { max_risk_level: 'medium' },
    filtering: {
      enabled: true,
      mcap: { min: 300_000, max: 4_000_000 },
      priceChange5m: { min: -30.0, max: -10.0 },
      priceChange1h: { min: 20.0, max: 80.0 },
      priceChange6h: { max: 70.0 },
      organicScore: { min: 65 },
      topHoldersPercentage: { max: 25 },
      requireCompleteData: true,
      checkManualTradingHistory: true,
    },
  },
  hodl: {
    id: 'hodl',
    name: 'HODL Strategy',
    description: 'Long-term holding strategy',
    is_active: false,
    take_profit_levels: {
      tp1_percentage: 100,
      tp1_sell_percentage: 25,
      tp2_percentage: 200,
      tp3_percentage: 500,
      tp3_enabled: true,
    },
    buy_amount_sol: 0.006,
    priority_fee_lamports: 1_000_000,
    stop_loss_percentage: -60,
    max_hold_hours: 168,
    conditions: {
      min_market_cap: 500_000,
      min_organic_score: 80,
      max_risk_level: 'low',
    },
    filtering: {
      enabled: true,
      mcap: { min: 1_000_000, max: 10_000_000 },
      priceChange5m: { max: -20.0 },
      priceChange1h: { max: 30.0 },
      priceChange6h: { max: 50.0 },
      organicScore: { min: 85 },
      topHoldersPercentage: { max: 15 },
      requireCompleteData: true,
      checkManualTradingHistory: true,
    },
  },
}

export const DEFAULT_SIGNALS_SCORING = {
  recencyBoostMax: 20,
  milestone80: 15,
  milestone120: 20,
  milestone200: 25,
  speedTo80Fast: 15,
  speedTo80Medium: 10,
  speedTo80Slow: 5,
  inTrackingRange: 10,
  stuckPenalty: 50,
  stopLossPenalty: 100,
  sellOver100LatePenalty: 40,
}

export const SIGNALS_STRATEGIES: Record<string, import('./types').SignalsStrategy> = {
  signals_default: {
    id: 'signals_default',
    name: 'Default momentum',
    description: 'Enter on strong growth + score floor',
    is_active: true,
    execution_mode: 'sim_only',
    config: {
      template: 'default',
      enterScoreFloor: 50,
      query: {
        limit: 50,
        recencyMinutes: 240,
        minGrowth: 0,
        holdGrowthFloor: 10,
        includeStuck: false,
        maxAgeMinutes: 2880,
      },
      scoring: { ...DEFAULT_SIGNALS_SCORING },
      execution: { simBuySol: 0.01, maxOpenPositions: 10 },
    },
  },
  signals_sell_over_100: {
    id: 'signals_sell_over_100',
    name: 'Sell over 100%',
    description:
      'Exit at ≥100% mcap growth from tracking baseline; sim PnL uses mcap (not rugged token price)',
    is_active: true,
    execution_mode: 'sim_only',
    config: {
      template: 'sell_over_100',
      enterScoreFloor: 50,
      query: {
        limit: 50,
        recencyMinutes: 240,
        minGrowth: 0,
        holdGrowthFloor: 10,
        includeStuck: false,
        maxAgeMinutes: 2880,
      },
      scoring: { ...DEFAULT_SIGNALS_SCORING },
      execution: { simBuySol: 0.01, maxOpenPositions: 10 },
    },
  },
}

export const DEFAULT_MCAP_TRACKER_EXIT = {
  stopLossPct: -50,
  takeProfitPct: 200,
  maxHoldHours: 96,
}

export const DEFAULT_MCAP_TRACKER_ENTRY = {
  mcapMin: 30_000,
  mcapMax: 2_000_000,
  organicScoreMin: undefined as number | undefined,
  topHoldersPctMax: undefined as number | undefined,
}

export const MCAP_TRACKER_STRATEGIES: Record<string, import('./types').McapTrackerStrategy> = {
  mcap_enter_first_seen: {
    id: 'mcap_enter_first_seen',
    name: 'Enter at first seen',
    description: 'Paper trade when token enters mcap tracking (first_mcap baseline)',
    is_active: true,
    execution_mode: 'sim_only',
    config: {
      entryTemplate: 'first_seen',
      query: { recencyMinutes: 240, limit: 300 },
      execution: { simBuySol: 0.01, maxOpenPositions: 10 },
      exit: { ...DEFAULT_MCAP_TRACKER_EXIT },
      entry: { ...DEFAULT_MCAP_TRACKER_ENTRY },
    },
  },
  mcap_enter_at_80: {
    id: 'mcap_enter_at_80',
    name: 'Enter at 80% milestone',
    description: 'Paper trade when token reaches 80% mcap growth milestone',
    is_active: true,
    execution_mode: 'sim_only',
    config: {
      entryTemplate: 'milestone_80',
      query: { recencyMinutes: 240, limit: 300 },
      execution: { simBuySol: 0.01, maxOpenPositions: 10 },
      exit: { ...DEFAULT_MCAP_TRACKER_EXIT },
      entry: { ...DEFAULT_MCAP_TRACKER_ENTRY },
    },
  },
}

export const DEFAULT_GMGN_SECURITY: import('./types').GmgnStrategyConfig['security'] = {
  enabled: true,
  requireRenouncedMint: true,
  requireRenouncedFreeze: true,
  maxTop10HolderRate: 0.2,
  maxRugRatio: 0.3,
  minSmartWallets: 3,
  maxSniperCount: 20,
  requireCreatorClosed: true,
  minLiquidityUsd: 10_000,
  maxCandidatesPerTick: 5,
  minVerdict: 'clean',
}

export const DEFAULT_GMGN_EXIT = {
  stopLossPct: -25,
  takeProfitPct: 50,
  maxHoldHours: 12,
}

/** Same SL/TP/hold as GMGN — Jupiter price basis for social-only sim. */
export const DEFAULT_SOCIAL_EXIT = { ...DEFAULT_GMGN_EXIT }

export const SOCIAL_STRATEGIES: Record<string, import('./types').SocialStrategy> = {
  social_only_fomo_gt7: {
    id: 'social_only_fomo_gt7',
    name: 'Social-only FOMO (>7)',
    description:
      'Paper trade when FOMO mentions >7 in 30m, also on TRENDINGSSOL, and only on social rollups',
    is_active: true,
    execution_mode: 'sim_only',
    config: {
      entry: {
        minMentions30m: 7,
        topSource: 'GMGN_Smart_Money_FOMO',
        maxCandidatesPerTick: 5,
        requireMentionSources: ['TRENDINGSSOL'],
        listenChannelPeers: { TRENDINGSSOL: '@trendingssol' },
      },
      execution: { simBuySol: 0.02, maxOpenPositions: 5 },
      exit: { ...DEFAULT_SOCIAL_EXIT },
    },
  },
}

export const DEFAULT_GMGN_RADAR: import('./types').GmgnRadarConfig = {
  stickyPumpPct: 50,
  dumpBanPct: -80,
  stickyTtlMinutes: 45,
  enterOverrideMinScore: 55,
  comeback: {
    enabled: true,
    drawdownPct: 70,
    troughMcapMax: 30_000,
    recoverMultiple: 1.5,
    minRadarScore: 45,
    unbanOnComeback: false,
    allowSimReopen: false,
  },
  telegram: {
    singleThread: true,
    minMcapUsd: 20_000,
  },
}

export const GMGN_STRATEGIES: Record<string, import('./types').GmgnStrategy> = {
  gmgn_smartmoney_default: {
    id: 'gmgn_smartmoney_default',
    name: 'GMGN Smart Money',
    description: 'Enter on fresh smart-money buys that pass GMGN security gate',
    is_active: false,
    execution_mode: 'sim_only',
    config: {
      discovery: {
        source: 'smartmoney',
        chain: 'sol',
        side: 'buy',
        limit: 20,
        minAmountUsd: 25,
        maxTradeAgeMinutes: 30,
        clusterMinWallets: 2,
        cooldownHours: 24,
      },
      security: { ...DEFAULT_GMGN_SECURITY },
      execution: { simBuySol: 0.02, maxOpenPositions: 5 },
      exit: { ...DEFAULT_GMGN_EXIT },
      radar: { ...DEFAULT_GMGN_RADAR, comeback: { ...DEFAULT_GMGN_RADAR.comeback }, telegram: { ...DEFAULT_GMGN_RADAR.telegram } },
    },
  },
  gmgn_kol_momentum: {
    id: 'gmgn_kol_momentum',
    name: 'GMGN KOL Momentum',
    description: 'Enter on fresh KOL buys that pass GMGN security gate',
    is_active: false,
    execution_mode: 'sim_only',
    config: {
      discovery: {
        source: 'kol',
        chain: 'sol',
        side: 'buy',
        limit: 20,
        minAmountUsd: 50,
        maxTradeAgeMinutes: 30,
        cooldownHours: 24,
      },
      security: { ...DEFAULT_GMGN_SECURITY },
      execution: { simBuySol: 0.02, maxOpenPositions: 5 },
      exit: { ...DEFAULT_GMGN_EXIT },
      radar: { ...DEFAULT_GMGN_RADAR, comeback: { ...DEFAULT_GMGN_RADAR.comeback }, telegram: { ...DEFAULT_GMGN_RADAR.telegram } },
    },
  },
  gmgn_sm_kol_combined: {
    id: 'gmgn_sm_kol_combined',
    name: 'GMGN SM + KOL Combined',
    description: 'Score-sorted discovery from smart money and KOL feeds (60m activity window)',
    is_active: false,
    execution_mode: 'sim_only',
    config: {
      discovery: {
        source: 'both',
        chain: 'sol',
        side: 'buy',
        limit: 50,
        minAmountUsd: 25,
        maxTradeAgeMinutes: 60,
        clusterMinWallets: 2,
        cooldownHours: 24,
      },
      security: { ...DEFAULT_GMGN_SECURITY },
      execution: { simBuySol: 0.02, maxOpenPositions: 5 },
      exit: { ...DEFAULT_GMGN_EXIT },
      radar: { ...DEFAULT_GMGN_RADAR, comeback: { ...DEFAULT_GMGN_RADAR.comeback }, telegram: { ...DEFAULT_GMGN_RADAR.telegram } },
    },
  },
}

export const DLMM_STRATEGY_DEFAULTS: import('./types').DlmmStrategy = {
  id: 'dlmm_default',
  name: 'DLMM Hunter/Healer',
  description: 'Meteora LP screener + reasoner thresholds',
  is_active: true,
  execution_mode: 'sim_only',
  config: {
    min_tvl: 50_000,
    min_fee_tvl: 0.1,
    min_organic_score: 50,
    min_holders: 100,
    take_profit_pct: 5,
    stop_loss_pct: -10,
    oor_timeout_min: 16,
    max_sol_per_position: 1,
    max_sol_at_risk: 5,
    bin_range_interval: 10,
    execution: {
      simDeploySol: 0.05,
      maxOpenPositions: 3,
      minCandidateScore: 15,
    },
  },
}

export const SIGNALS_STRATEGY_META = [
  {
    id: 'default' as const,
    name: 'Default momentum',
    description: 'Enter on strong growth + score ≥ 50',
    params: { minGrowthDefault: 0, recencyMinutesDefault: 240, enterScoreFloor: 50 },
  },
  {
    id: 'sell_over_100' as const,
    name: 'Sell over 100%',
    description: 'Favor exit above 100% growth; penalize late surges',
    params: { minGrowthDefault: 0, recencyMinutesDefault: 240, enterScoreFloor: 50 },
  },
]
