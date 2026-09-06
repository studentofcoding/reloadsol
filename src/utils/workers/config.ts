export type WorkerId =
  | 'signals_sim_track'
  | 'mcap_tracker_sim_open'
  | 'mcap_tracker_sim_track'
  | 'gmgn_sim_track'
  | 'gmgn_activity_poll'
  | 'gmgn_radar_digest'
  | 'gmgn_wallet_digger'
  | 'gmgn_roster_watch'
  | 'social_sim_track'
  | 'social_rollup'
  | 'social_wallet_poll'
  | 'signals_refresh'
  | 'trending_tracker'
  | 'dlmm_screen'
  | 'dlmm_sim_track'
  | 'dlmm_manage'
  | 'strategy_report'
  | 'sltp_monitor'
  | 'daily_summary'
  | 'pnl_update'
  | 'sol_arb_scan'
  | 'fomo_ws'
  | 'rh_lp_screen'
  | 'strategy_search'

export const WORKER_TRIGGER_PATHS: Record<WorkerId, string> = {
  signals_sim_track: '/trigger/signals-sim-track',
  mcap_tracker_sim_open: '/trigger/mcap-tracker-sim-open',
  mcap_tracker_sim_track: '/trigger/mcap-tracker-sim-track',
  gmgn_sim_track: '/trigger/gmgn-sim-track',
  gmgn_activity_poll: '/trigger/gmgn-activity-poll',
  gmgn_radar_digest: '/trigger/gmgn-radar-digest',
  gmgn_wallet_digger: '/trigger/gmgn-wallet-digger',
  gmgn_roster_watch: '/trigger/gmgn-roster-watch',
  social_sim_track: '/trigger/social-sim-track',
  social_rollup: '/trigger/social-rollup',
  social_wallet_poll: '/trigger/social-wallet-poll',
  signals_refresh: '/trigger/signals-refresh',
  trending_tracker: '/trigger/trending',
  dlmm_screen: '/trigger/dlmm-screen',
  dlmm_sim_track: '/trigger/dlmm-sim-track',
  dlmm_manage: '/trigger/dlmm-manage',
  strategy_report: '/trigger/strategy-report',
  sltp_monitor: '/trigger/sltp',
  daily_summary: '/trigger/summary',
  pnl_update: '/trigger/pnl',
  sol_arb_scan: '/trigger/sol-arb-scan',
  fomo_ws: '/trigger/fomo-ws',
  rh_lp_screen: '/trigger/rh-lp-screen',
  strategy_search: '/trigger/strategy-search',
}

export function getCronServiceUrl(): string {
  return (
    process.env.CRON_SERVICE_URL ||
    process.env.NEXT_PUBLIC_CRON_SERVICE_URL ||
    'http://127.0.0.1:8080'
  ).replace(/\/$/, '')
}

/**
 * Shared secret the Go cron expects on /trigger/* (X-Trigger-Secret header).
 * Mirrors the Go fallback chain: TRIGGER_SECRET → TRENDING_TRACKER_SECRET.
 */
export function getCronTriggerSecret(): string {
  return (
    process.env.TRIGGER_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    ''
  )
}

export function isKnownWorkerId(id: string): id is WorkerId {
  return id in WORKER_TRIGGER_PATHS
}
