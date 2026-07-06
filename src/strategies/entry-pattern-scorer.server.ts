import fs from 'node:fs'
import path from 'path'
import { extractPatternFeaturesFromLiveEntry } from './social/pattern-features'
import {
  getPatternMlMode,
  getPatternPWinnerMin,
  isPatternModelReady,
  patternFeatureVectorToTensorInput,
  resolvePatternDecisionThreshold,
  scorePatternBinary,
  type PatternEnforceResult,
  type PatternMlShadowScore,
} from './entry-pattern-scorer'
import {
  getPatternLoadError,
  getPatternModelCache,
  isPatternLoadAttempted,
  markPatternLoadAttempted,
  setPatternLoadError,
  setPatternModelCache,
  type LoadedPatternModel,
} from './entry-pattern-scorer-cache'

type PatternArtifactMetaModule = typeof import('./pattern-artifact-meta.server')

function getPatternArtifactMeta(): Promise<PatternArtifactMetaModule> {
  return import('./pattern-artifact-meta.server')
}

async function getPatternModel(): Promise<LoadedPatternModel | null> {
  if (!isPatternLoadAttempted()) {
    markPatternLoadAttempted()
    const patternMeta = await getPatternArtifactMeta()
    const artifactDir = patternMeta.resolvePatternArtifactDir()
    const meta = await patternMeta.readPatternModelMeta()
    if (!meta) {
      console.warn(
        `[ml-pattern] shadow scoring disabled: model.meta.json missing or invalid in ${artifactDir}`,
      )
      setPatternModelCache(null)
      return null
    }

    const onnxPath = path.join(artifactDir, 'model.onnx')
    if (!fs.existsSync(/* turbopackIgnore: true */ onnxPath)) {
      console.warn(`[ml-pattern] shadow scoring disabled: ${onnxPath} not found`)
      setPatternModelCache(null)
      return null
    }

    try {
      const ort = await import('onnxruntime-node')
      const session = await ort.InferenceSession.create(onnxPath)
      const version = meta.version ?? path.basename(artifactDir)
      setPatternModelCache({
        meta,
        session: session as unknown as LoadedPatternModel['session'],
        artifactDir,
      })
    } catch (error) {
      console.warn(
        '[ml-pattern] shadow scoring disabled: ONNX session failed to load —',
        error instanceof Error ? error.message : String(error),
      )
      setPatternModelCache(null)
    }
  }
  return getPatternModelCache() ?? null
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
    const threshold = resolvePatternDecisionThreshold(loaded.meta)
    const pattern = scorePatternBinary(out, threshold)
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

export async function getPatternRuntimeLoadStatus(): Promise<{
  runtime_loaded: boolean
  model_version: string | null
  error: string | null
}> {
  const loaded = await getPatternModel()
  const ready = isPatternModelReady(loaded?.meta)
  if (loaded && ready) {
    return {
      runtime_loaded: true,
      model_version: loaded.meta.version ?? path.basename(loaded.artifactDir),
      error: null,
    }
  }

  return {
    runtime_loaded: false,
    model_version: null,
    error: getPatternLoadError() ?? 'pattern model not loaded',
  }
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

export { resetPatternScorerCache } from './entry-pattern-scorer-cache'
