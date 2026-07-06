export type McapToastItem = {
  symbol: string
  address: string
  growthPercent: number
  pWinner?: number
  predicted?: 'winner' | 'loser'
}

export type McapToast = {
  type: 'success' | 'info' | 'warning'
  title: string
  message: string
  items?: McapToastItem[]
  key?: string
  category?: 'tracked' | 'threshold' | 'high_performers' | 'predictive'
}
