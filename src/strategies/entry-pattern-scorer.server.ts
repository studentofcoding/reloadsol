import path from 'path'
import { extractPatternFeaturesFromLiveEntry } from './social/pattern-features'
import {
  getPatternMlMode,
  getPatternPWinnerMin,
  isPatternModelReady,
  patternFeatureVectorToTensorInput,
  scorePatternBinary,
  type PatternEnforceResult,
  type PatternMlShadowScore,
  type PatternModelMeta,
} from './entry-pattern-scorer'

type OrtSession = {
  inputNames: string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>
}

type LoadedPatternModel = {
  meta: PatternModelMeta
  session: OrtSession
  artifactDir: string
}

let patternModel: LoadedPatternModel | null | undefined
let patternLoadAttempted = false

function resolveArtifactDir(): string | null {
  const fromEnv = process.env.ML_PATTERN_ARTIFACT_DIR?.trim()
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.join(/* turbopackIgnore: true */ process.cwd(), fromEnv)
  }
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'ml', 'artifacts', 'pattern-gate')
}

async function readMeta(artifactDir: string): Promise<PatternModelMeta | null> {
  const fs = await import('node:fs')
  const metaPath = path.join(artifactDir, 'model.meta.json')
  if (!fs.existsSync(metaPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PatternModelMeta
    if (!Array.isArray(raw.feature_columns) || raw.feature_columns.length === 0) return null
    return raw
  } catch {
    return null
  }
}

async function getPatternModel(): Promise<LoadedPatternModel | null> {
  if (!patternLoadAttempted) {
    patternLoadAttempted = true
    const artifactDir = resolveArtifactDir()
    if (!artifactDir) {
      patternModel = null
      return null
    }

    const meta = await readMeta(artifactDir)
    if (!meta) {
      patternModel = null
      return null
    }

    const fs = await import('node:fs')
    const onnxPath = path.join(artifactDir, 'model.onnx')
    if (!fs.existsSync(onnxPath)) {
      patternModel = null
      return null
    }

    try {
      const ort = await import('onnxruntime-node')
      const session = await ort.InferenceSession.create(onnxPath)
      patternModel = {
        meta,
        session: session as unknown as OrtSession,
        artifactDir,
      }
    } catch {
      patternModel = null
    }
  }
  return patternModel ?? null
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

export async function scorePatternFeaturesShadow(
  entryFeatures: Record<string, unknown>,
): Promise<PatternMlShadowScore | null> {
  if (getPatternMlMode() === 'off') return null

  const vector = extractPatternFeaturesFromLiveEntry(entryFeatures)
  if (!vector) return null

  const loaded = await getPatternModel()
  if (!loaded) return null

  try {
    const ort = await import('onnxruntime-node')
    const input = patternFeatureVectorToTensorInput(loaded.meta.feature_columns, vector)
    const inputName = loaded.session.inputNames[0] ?? 'input'
    const tensor = new ort.Tensor('float32', input, [1, input.length])
    const result = await loaded.session.run({ [inputName]: tensor })
    const out = firstOutputTensor(result)
    const pattern = scorePatternBinary(out)
    return {
      pattern,
      modelVersion: loaded.meta.version ?? path.basename(loaded.artifactDir),
      scoredAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export async function getPatternModelReady(): Promise<boolean> {
  const loaded = await getPatternModel()
  return isPatternModelReady(loaded?.meta)
}

export async function getPatternModelVersion(): Promise<string | null> {
  const loaded = await getPatternModel()
  if (!loaded) return null
  return loaded.meta.version ?? path.basename(loaded.artifactDir)
}

export async function evaluatePatternEnforce(
  shadow: PatternMlShadowScore | null,
): Promise<PatternEnforceResult> {
  if (getPatternMlMode() !== 'enforce') {
    return { reject: false, reason: null, pWinner: shadow?.pattern?.pWinner ?? null }
  }

  const ready = await getPatternModelReady()
  if (!ready) {
    return { reject: false, reason: 'pattern_not_ready', pWinner: shadow?.pattern?.pWinner ?? null }
  }

  const pWinner = shadow?.pattern?.pWinner
  if (pWinner == null || !Number.isFinite(pWinner)) {
    return { reject: false, reason: 'no_pattern_score', pWinner: null }
  }

  const threshold = getPatternPWinnerMin()
  if (pWinner < threshold) {
    return {
      reject: true,
      reason: `ml_pattern_reject (p_winner=${pWinner.toFixed(3)} < ${threshold})`,
      pWinner,
    }
  }

  return { reject: false, reason: null, pWinner }
}

export function resetPatternScorerCache(): void {
  patternModel = undefined
  patternLoadAttempted = false
}
