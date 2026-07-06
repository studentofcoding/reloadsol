import type { PatternModelMeta } from './entry-pattern-scorer'

export type CachedPatternOrtSession = {
  inputNames: string[]
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { data: Float32Array | number[] }>>
}

export type LoadedPatternModel = {
  meta: PatternModelMeta
  session: CachedPatternOrtSession
  artifactDir: string
}

let patternModel: LoadedPatternModel | null | undefined
let patternLoadAttempted = false
let patternLoadError: string | null = null

export function getPatternModelCache(): LoadedPatternModel | null | undefined {
  return patternModel
}

export function setPatternModelCache(model: LoadedPatternModel | null): void {
  patternModel = model
}

export function isPatternLoadAttempted(): boolean {
  return patternLoadAttempted
}

export function markPatternLoadAttempted(): void {
  patternLoadAttempted = true
}

export function getPatternLoadError(): string | null {
  return patternLoadError
}

export function setPatternLoadError(error: string | null): void {
  patternLoadError = error
}

export function resetPatternScorerCache(): void {
  patternModel = undefined
  patternLoadAttempted = false
  patternLoadError = null
}
