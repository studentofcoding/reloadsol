export type McapToastItem = {
  symbol: string
  address: string
  growthPercent: number
  pWinner?: number
  predicted?: 'winner' | 'loser'
  strategyId?: string
  entryMcap?: number
  entryTemplate?: 'first_seen' | 'milestone_80'
}

export type McapToast = {
  type: 'success' | 'info' | 'warning'
  title: string
  message: string
  items?: McapToastItem[]
  key?: string
  category?: 'tracked' | 'threshold' | 'high_performers' | 'predictive' | 'sim_open'
}
