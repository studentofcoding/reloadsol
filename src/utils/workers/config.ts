export type WorkerId =
  | 'signals_sim_track'
  | 'signals_refresh'
  | 'trending_tracker'
  | 'dlmm_screen'
  | 'dlmm_manage'
  | 'strategy_report'
  | 'sltp_monitor'
  | 'daily_summary'
  | 'pnl_update'

export const WORKER_TRIGGER_PATHS: Record<WorkerId, string> = {
  signals_sim_track: '/trigger/signals-sim-track',
  signals_refresh: '/trigger/signals-refresh',
  trending_tracker: '/trigger/trending',
  dlmm_screen: '/trigger/dlmm-screen',
  dlmm_manage: '/trigger/dlmm-manage',
  strategy_report: '/trigger/strategy-report',
  sltp_monitor: '/trigger/sltp',
  daily_summary: '/trigger/summary',
  pnl_update: '/trigger/pnl',
}

export function getCronServiceUrl(): string {
  return (
    process.env.CRON_SERVICE_URL ||
    process.env.NEXT_PUBLIC_CRON_SERVICE_URL ||
    'http://127.0.0.1:8080'
  ).replace(/\/$/, '')
}

export function isKnownWorkerId(id: string): id is WorkerId {
  return id in WORKER_TRIGGER_PATHS
}
