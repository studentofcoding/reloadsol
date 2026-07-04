import { PATTERN_FEATURE_KEYS } from './social/pattern-features'

export type PatternModelMeta = {
  version?: string
  model_type?: 'binary'
  stage?: 'pattern-gate'
  feature_columns: string[]
  metrics?: {
    pattern_ready?: boolean
    macro_f1?: number
  }
}

export type PatternShadowResult = {
  pWinner: number
  pLoser: number
  predicted: 'winner' | 'loser'
}

export type PatternMlShadowScore = {
  pattern: PatternShadowResult | null
  modelVersion?: string
  scoredAt: string
}

export type PatternEnforceResult = {
  reject: boolean
  reason: string | null
  pWinner: number | null
}

export function patternFeatureVectorToTensorInput(
  featureColumns: string[],
  vector: Record<string, number>,
): Float32Array {
  const arr = new Float32Array(featureColumns.length)
  for (let i = 0; i < featureColumns.length; i++) {
    const v = vector[featureColumns[i]]
    arr[i] = typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  return arr
}

export function scorePatternBinary(data: Float32Array): PatternShadowResult {
  let pWinner: number
  if (data.length === 1) {
    pWinner = data[0]
  } else if (data.length >= 2) {
    pWinner = data[1]
  } else {
    pWinner = 0.5
  }
  pWinner = Math.min(1, Math.max(0, pWinner))
  const pLoser = 1 - pWinner
  const predicted: 'winner' | 'loser' = pWinner >= 0.5 ? 'winner' : 'loser'
  return { pWinner, pLoser, predicted }
}

export function getPatternMlMode(): 'off' | 'shadow' | 'enforce' {
  const mode = process.env.ML_PATTERN_MODE?.toLowerCase()
  if (mode === 'enforce') return 'enforce'
  if (mode === 'off') return 'off'
  return 'shadow'
}

export function getPatternPWinnerMin(): number {
  const raw = process.env.ML_PATTERN_P_WINNER_MIN
  if (raw == null || raw === '') return 0.5
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.5
}

export function isPatternModelReady(meta: PatternModelMeta | null | undefined): boolean {
  return meta?.metrics?.pattern_ready === true
}

export function defaultPatternFeatureColumns(): string[] {
  return [...PATTERN_FEATURE_KEYS]
}
