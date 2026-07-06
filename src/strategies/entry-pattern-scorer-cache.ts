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

export function resetPatternScorerCache(): void {
  patternModel = undefined
  patternLoadAttempted = false
}
