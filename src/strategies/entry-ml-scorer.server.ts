import path from 'path'
import { extractMlFeatureVector } from './ml-training-features'
import {
  featureVectorToTensorInput,
  getMlGateMode,
  getMlGatePBadMax,
  isGateModelReady,
  scoreBinaryGate,
  scorePotentialTier,
  type EntryMlShadowScore,
  type GateShadowResult,
  type MlGateEnforceResult,
  type MlModelMeta,
  type PotentialShadowResult,
} from './entry-ml-scorer'

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

/** Resolve artifact dir from env only — avoids Turbopack tracing ml/ during build. */
function resolveArtifactDir(envKey: string, defaultSubdir: string): string | null {
  const fromEnv = process.env[envKey]?.trim()
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.join(/* turbopackIgnore: true */ process.cwd(), fromEnv)
  }
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'artifacts', defaultSubdir)
}

async function readMeta(artifactDir: string): Promise<MlModelMeta | null> {
  const fs = await import('node:fs')
  const metaPath = path.join(artifactDir, 'model.meta.json')
  if (!fs.existsSync(metaPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MlModelMeta
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
  if (!artifactDir) return null

  const meta = await readMeta(artifactDir)
  if (!meta) return null

  const fs = await import('node:fs')
  const onnxPath = path.join(artifactDir, 'model.onnx')
  if (!fs.existsSync(onnxPath)) return null

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

function firstOutputTensor(
  result: Record<string, { data: Float32Array | number[] }>,
): Float32Array {
  const key = Object.keys(result)[0]
  const tensor = result[key]
  const data = tensor?.data
  if (data instanceof Float32Array) return data
  return Float32Array.from(data ?? [])
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

export async function getGateModelReady(): Promise<boolean> {
  const loaded = await getGateModel()
  return isGateModelReady(loaded?.meta)
}

/** When ML_GATE_MODE=enforce and gate_ready, reject high p_bad entries. Default mode stays shadow. */
export async function evaluateMlGateEnforce(
  shadow: EntryMlShadowScore | null,
): Promise<MlGateEnforceResult> {
  if (getMlGateMode() !== 'enforce') {
    return { reject: false, reason: null, pBad: shadow?.gate?.pBad ?? null }
  }

  const gateReady = await getGateModelReady()
  if (!gateReady) {
    return { reject: false, reason: 'gate_not_ready', pBad: shadow?.gate?.pBad ?? null }
  }

  const pBad = shadow?.gate?.pBad
  if (pBad == null || !Number.isFinite(pBad)) {
    return { reject: false, reason: 'no_gate_score', pBad: null }
  }

  const threshold = getMlGatePBadMax()
  if (pBad > threshold) {
    return {
      reject: true,
      reason: `ml_gate_reject (p_bad=${pBad.toFixed(3)} > ${threshold})`,
      pBad,
    }
  }

  return { reject: false, reason: null, pBad }
}
