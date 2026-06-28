import path from 'path'
import { readFileSync, existsSync } from 'fs'
import { extractMlFeatureVector } from './ml-training-features'

export type MlModelMeta = {
  version?: string
  model_type?: 'binary' | 'potential_tier' | 'multiclass'
  stage?: 'gate' | 'potential' | 'multiclass'
  feature_columns: string[]
  num_classes?: number
  potential_tier_min?: number
  potential_tier_max?: number
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

type OrtSession = {
  inputNames: string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[]; dims?: number[] }>>
}

type LoadedStageModel = {
  meta: MlModelMeta
  session: OrtSession
  artifactDir: string
}

let gateModel: LoadedStageModel | null | undefined
let potentialModel: LoadedStageModel | null | undefined
let gateLoadAttempted = false
let potentialLoadAttempted = false

function resolveArtifactDir(envKey: string, defaultSubdir: string): string {
  const fromEnv = process.env[envKey]
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(process.cwd(), fromEnv)
  return path.join(process.cwd(), 'ml', 'artifacts', defaultSubdir)
}

function readMeta(artifactDir: string): MlModelMeta | null {
  const metaPath = path.join(artifactDir, 'model.meta.json')
  if (!existsSync(metaPath)) return null
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as MlModelMeta
    if (!Array.isArray(raw.feature_columns) || raw.feature_columns.length === 0) return null
    return raw
  } catch {
    return null
  }
}

async function loadStageModel(
  envKey: string,
  defaultSubdir: string,
): Promise<LoadedStageModel | null> {
  const artifactDir = resolveArtifactDir(envKey, defaultSubdir)
  const meta = readMeta(artifactDir)
  if (!meta) return null

  const onnxPath = path.join(artifactDir, 'model.onnx')
  if (!existsSync(onnxPath)) return null

  try {
    const ort = await import('onnxruntime-node')
    const session = await ort.InferenceSession.create(onnxPath)
    return {
      meta,
      session: session as unknown as OrtSession,
      artifactDir,
    }
  } catch {
    return null
  }
}

async function getGateModel(): Promise<LoadedStageModel | null> {
  if (!gateLoadAttempted) {
    gateLoadAttempted = true
    gateModel = await loadStageModel('ML_GATE_ARTIFACT_DIR', 'v2-gate')
  }
  return gateModel ?? null
}

async function getPotentialModel(): Promise<LoadedStageModel | null> {
  if (!potentialLoadAttempted) {
    potentialLoadAttempted = true
    potentialModel = await loadStageModel('ML_POTENTIAL_ARTIFACT_DIR', 'v2-potential')
  }
  return potentialModel ?? null
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

function firstOutputTensor(
  result: Record<string, { data: Float32Array | number[] }>,
): Float32Array {
  const key = Object.keys(result)[0]
  const tensor = result[key]
  const data = tensor?.data
  if (data instanceof Float32Array) return data
  return Float32Array.from(data ?? [])
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

  const moonScore =
    (probs[3] ?? 0) + (probs[4] ?? 0)

  return { tier: bestTier, probs, moonScore }
}

async function runModel(
  loaded: LoadedStageModel,
  vector: Record<string, number>,
): Promise<Float32Array> {
  const ort = await import('onnxruntime-node')
  const input = featureVectorToTensorInput(loaded.meta.feature_columns, vector)
  const inputName = loaded.session.inputNames[0] ?? 'input'
  const tensor = new ort.Tensor('float32', input, [1, input.length])
  const result = await loaded.session.run({ [inputName]: tensor })
  return firstOutputTensor(result)
}

export async function scoreEntryFeaturesShadow(
  entryFeatures: Record<string, unknown>,
): Promise<EntryMlShadowScore | null> {
  const vector = extractMlFeatureVector(entryFeatures)
  if (!vector) return null

  const scoredAt = new Date().toISOString()
  const modelVersions: EntryMlShadowScore['modelVersions'] = {}
  let gate: GateShadowResult | null = null
  let potential: PotentialShadowResult | null = null

  const gateLoaded = await getGateModel()
  if (gateLoaded) {
    try {
      const out = await runModel(gateLoaded, vector)
      gate = scoreBinaryGate(out)
      modelVersions.gate = gateLoaded.meta.version ?? path.basename(gateLoaded.artifactDir)
    } catch {
      gate = null
    }
  }

  const potentialLoaded = await getPotentialModel()
  if (potentialLoaded) {
    try {
      const out = await runModel(potentialLoaded, vector)
      potential = scorePotentialTier(out, potentialLoaded.meta)
      modelVersions.potential =
        potentialLoaded.meta.version ?? path.basename(potentialLoaded.artifactDir)
    } catch {
      potential = null
    }
  }

  if (!gate && !potential) return null

  return { gate, potential, modelVersions, scoredAt }
}

/** Reset cached sessions (tests). */
export function resetMlScorerCache(): void {
  gateModel = undefined
  potentialModel = undefined
  gateLoadAttempted = false
  potentialLoadAttempted = false
}

export function getMlGateMode(): 'off' | 'shadow' | 'enforce' {
  const mode = process.env.ML_GATE_MODE?.toLowerCase()
  if (mode === 'enforce') return 'enforce'
  if (mode === 'off') return 'off'
  return 'shadow'
}
