import path from 'path'
import { isPatternModelReady, type PatternModelMeta } from './entry-pattern-scorer'

export type PatternPipelineState = {
  last_run_at?: string
  status?: 'success' | 'partial' | 'failed'
  export_rows?: number
  train_ready?: boolean
  train_skipped_reason?: string | null
  trained_at?: string | null
  macro_f1?: number | null
  pattern_ready?: boolean | null
  web_reloaded?: boolean
  log_tail?: string[]
}

export type PatternModelStats = {
  trained_at: string | null
  macro_f1: number | null
  pattern_ready: boolean | null
  class_counts: Record<string, number> | null
  top_features: Array<{ name: string; importance: number }>
}

type RawPatternMeta = PatternModelMeta & {
  trained_at?: string
  class_counts?: Record<string, number>
  feature_importance?: Record<string, number>
}

export function resolvePatternArtifactDir(): string | null {
  const fromEnv = process.env.ML_PATTERN_ARTIFACT_DIR?.trim()
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.join(/* turbopackIgnore: true */ process.cwd(), fromEnv)
  }
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'ml', 'artifacts', 'pattern-gate')
}

async function readArtifactJson<T>(filename: string): Promise<T | null> {
  const artifactDir = resolvePatternArtifactDir()
  if (!artifactDir) return null
  const fs = await import('node:fs')
  const filePath = path.join(artifactDir, filename)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

export async function readPatternModelMeta(): Promise<PatternModelMeta | null> {
  const meta = await readArtifactJson<PatternModelMeta>('model.meta.json')
  if (!meta || !Array.isArray(meta.feature_columns) || meta.feature_columns.length === 0) {
    return null
  }
  return meta
}

export async function getPatternPipelineState(): Promise<PatternPipelineState | null> {
  return readArtifactJson<PatternPipelineState>('pipeline_state.json')
}

export async function getPatternModelStats(): Promise<PatternModelStats | null> {
  const meta = await readArtifactJson<RawPatternMeta>('model.meta.json')
  if (!meta) return null

  const importance = meta.feature_importance ?? {}
  const top_features = Object.entries(importance)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, score]) => ({ name, importance: score }))

  return {
    trained_at: meta.trained_at ?? null,
    macro_f1: meta.metrics?.macro_f1 ?? null,
    pattern_ready: meta.metrics?.pattern_ready ?? null,
    class_counts: meta.class_counts ?? null,
    top_features,
  }
}

export async function getPatternModelReadyFromMeta(): Promise<boolean> {
  const meta = await readPatternModelMeta()
  return isPatternModelReady(meta)
}

export async function getPatternModelVersionFromMeta(): Promise<string | null> {
  const artifactDir = resolvePatternArtifactDir()
  const meta = await readPatternModelMeta()
  if (!meta || !artifactDir) return null
  return meta.version ?? path.basename(artifactDir)
}
