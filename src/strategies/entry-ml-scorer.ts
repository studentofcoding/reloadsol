export type MlModelMeta = {
  version?: string
  model_type?: 'binary' | 'potential_tier'
  stage?: 'gate' | 'potential'
  feature_columns: string[]
  num_classes?: number
  potential_tier_min?: number
  potential_tier_max?: number
  metrics?: {
    gate_ready?: boolean
    potential_ready?: boolean
    macro_f1?: number
  }
}

export type GateShadowResult = {
  pBad: number
  pGood: number
  predicted: 0 | 1
}

export type PotentialShadowResult = {
  tier: 1 | 2 | 3 | 4
  probs: Record<number, number>
  moonScore: number
}

export type EntryMlShadowScore = {
  gate: GateShadowResult | null
  potential: PotentialShadowResult | null
  modelVersions: { gate?: string; potential?: string }
  scoredAt: string
}

export type MlGateEnforceResult = {
  reject: boolean
  reason: string | null
  pBad: number | null
}

/** Pack feature dict into column order expected by ONNX models. */
export function featureVectorToTensorInput(
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

export function scoreBinaryGate(data: Float32Array): GateShadowResult {
  let pGood: number
  if (data.length === 1) {
    pGood = data[0]
  } else if (data.length >= 2) {
    pGood = data[1]
  } else {
    pGood = 0.5
  }
  pGood = Math.min(1, Math.max(0, pGood))
  const pBad = 1 - pGood
  const predicted: 0 | 1 = pGood >= 0.5 ? 1 : 0
  return { pBad, pGood, predicted }
}

export function scorePotentialTier(data: Float32Array, meta: MlModelMeta): PotentialShadowResult {
  const tierMin = meta.potential_tier_min ?? 1
  const numClasses = meta.num_classes ?? 4
  const probs: Record<number, number> = {}
  let bestTier = tierMin as 1 | 2 | 3 | 4
  let bestProb = -1

  for (let i = 0; i < Math.min(data.length, numClasses); i++) {
    const tier = (tierMin + i) as 1 | 2 | 3 | 4
    const p = Math.min(1, Math.max(0, data[i]))
    probs[tier] = p
    if (p > bestProb) {
      bestProb = p
      bestTier = tier
    }
  }

  const moonScore = (probs[3] ?? 0) + (probs[4] ?? 0)

  return { tier: bestTier, probs, moonScore }
}

export function getMlGateMode(): 'off' | 'shadow' | 'enforce' {
  const mode = process.env.ML_GATE_MODE?.toLowerCase()
  if (mode === 'enforce') return 'enforce'
  if (mode === 'off') return 'off'
  return 'shadow'
}

export function getMlGatePBadMax(): number {
  const raw = process.env.ML_GATE_P_BAD_MAX
  if (raw == null || raw === '') return 0.5
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.5
}

export function isGateModelReady(meta: MlModelMeta | null | undefined): boolean {
  return meta?.metrics?.gate_ready === true
}

/** v2-potential readiness (legacy meta may only have gate_ready). */
export function isPotentialModelReady(meta: MlModelMeta | null | undefined): boolean {
  if (meta?.metrics?.potential_ready === true) return true
  if (meta?.stage === 'potential' && meta?.metrics?.gate_ready === true) return true
  return false
}
