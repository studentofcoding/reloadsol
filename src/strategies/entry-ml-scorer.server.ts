import fs from 'node:fs'
import path from 'path'
import { extractMlFeatureVector } from './ml-training-features'
import { validateModelSchema } from './feature-registry'
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
let gateSchemaError: string | null = null
let potentialSchemaError: string | null = null

export type MlSchemaStatus = { schema_ok: boolean; schema_error: string | null }

/** Why the gate/potential head is refusing to score, if it is. Named, never a bare null. */
export function getGateSchemaStatus(): MlSchemaStatus {
  return { schema_ok: gateSchemaError == null, schema_error: gateSchemaError }
}

export function getPotentialSchemaStatus(): MlSchemaStatus {
  return { schema_ok: potentialSchemaError == null, schema_error: potentialSchemaError }
}

/** Resolve artifact dir from env only — avoids Turbopack tracing ml/ during build. */
function resolveArtifactDir(envKey: string, defaultSubdir: string): string {
  const fromEnv = process.env[envKey]?.trim()
  if (fromEnv) return fromEnv
  return path.join(process.cwd(), 'artifacts', defaultSubdir)
}

type MetaRead =
  | { meta: MlModelMeta; schemaError: null }
  | { meta: null; schemaError: string | null }

async function readMeta(artifactDir: string): Promise<MetaRead> {
  const metaPath = path.join(artifactDir, 'model.meta.json')
  if (!fs.existsSync(/* turbopackIgnore: true */ metaPath)) {
    return { meta: null, schemaError: null }
  }
  let raw: MlModelMeta
  try {
    raw = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ metaPath, 'utf8'),
    ) as MlModelMeta
  } catch {
    return { meta: null, schemaError: null }
  }
  if (!Array.isArray(raw.feature_columns) || raw.feature_columns.length === 0) {
    return { meta: null, schemaError: null }
  }

  const verdict = validateModelSchema({
    stage: 'entry',
    columns: raw.feature_columns,
    version: raw.feature_schema_version ?? null,
  })
  if (!verdict.ok) {
    console.warn(
      `[ml-gate] refusing to score ${artifactDir} — feature schema mismatch: ${verdict.reason}`,
    )
    return { meta: null, schemaError: verdict.reason }
  }
  return { meta: raw, schemaError: null }
}

type StageLoad =
  | { ok: true; model: LoadedStageModel }
  | { ok: false; schemaError: string | null; reason: string }

async function loadStageModel(
  envKey: string,
  defaultSubdir: string,
): Promise<StageLoad> {
  const artifactDir = resolveArtifactDir(envKey, defaultSubdir)
  if (!artifactDir) return { ok: false, schemaError: null, reason: 'no artifact dir' }

  const read = await readMeta(artifactDir)
  if (!read.meta) {
    return {
      ok: false,
      schemaError: read.schemaError,
      reason:
        read.schemaError ?? `model.meta.json missing or invalid in ${artifactDir}`,
    }
  }

  const onnxPath = path.join(artifactDir, 'model.onnx')
  if (!fs.existsSync(/* turbopackIgnore: true */ onnxPath)) {
    return { ok: false, schemaError: null, reason: `${onnxPath} not found` }
  }

  try {
    const ort = await import('onnxruntime-node')
    const session = await ort.InferenceSession.create(onnxPath)
    return {
      ok: true,
      model: {
        meta: read.meta,
        session: session as unknown as OrtSession,
        artifactDir,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, schemaError: null, reason: `ONNX session failed: ${message}` }
  }
}

async function getGateModel(): Promise<LoadedStageModel | null> {
  if (!gateLoadAttempted) {
    gateLoadAttempted = true
    const result = await loadStageModel('ML_GATE_ARTIFACT_DIR', 'v2-gate')
    gateModel = result.ok ? result.model : null
    gateSchemaError = result.ok ? null : result.schemaError
    if (!result.ok && result.schemaError == null) {
      console.warn(`[ml-gate] shadow scoring disabled: ${result.reason}`)
    }
  }
  return gateModel ?? null
}

async function getPotentialModel(): Promise<LoadedStageModel | null> {
  if (!potentialLoadAttempted) {
    potentialLoadAttempted = true
    const result = await loadStageModel('ML_POTENTIAL_ARTIFACT_DIR', 'v2-potential')
    potentialModel = result.ok ? result.model : null
    potentialSchemaError = result.ok ? null : result.schemaError
    if (!result.ok && result.schemaError == null) {
      console.warn(`[ml-potential] shadow scoring disabled: ${result.reason}`)
    }
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
