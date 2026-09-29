/** Shadow risk chip shown wherever a token is listed. Display-only. */
export type RiskChipTone = 'red' | 'amber' | 'emerald' | 'gray'

export type RiskChipData = {
  text: string
  tone: RiskChipTone
  /** 'shadow' until the feature is enforced — rendered text already says so. */
  mode: 'shadow' | 'enforce'
  reasons: string[]
}
