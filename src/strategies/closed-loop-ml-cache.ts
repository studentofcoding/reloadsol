import fs from 'node:fs'
import path from 'path'
import {
  parseClosedLoopModel,
  resolveClosedLoopArtifactPath,
  type ClosedLoopModelArtifact,
} from './closed-loop-ml'

let cached: ClosedLoopModelArtifact | null | undefined
let cachedPath: string | null = null

export function invalidateClosedLoopModelCache(): void {
  cached = undefined
  cachedPath = null
}

export function peekClosedLoopModelCache(): ClosedLoopModelArtifact | null | undefined {
  return cached
}

export function loadClosedLoopModel(
  env: NodeJS.ProcessEnv = process.env,
): ClosedLoopModelArtifact | null {
  const artifactPath = resolveClosedLoopArtifactPath(env)
  if (cached !== undefined && cachedPath === artifactPath) return cached

  try {
    if (!fs.existsSync(/* turbopackIgnore: true */ artifactPath)) {
      cached = null
      cachedPath = artifactPath
      return null
    }
    const raw = fs.readFileSync(artifactPath, 'utf8')
    const parsed = parseClosedLoopModel(JSON.parse(raw) as unknown)
    cached = parsed
    cachedPath = artifactPath
    return parsed
  } catch {
    cached = null
    cachedPath = artifactPath
    return null
  }
}

export function saveClosedLoopModel(
  model: ClosedLoopModelArtifact,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const artifactPath = resolveClosedLoopArtifactPath(env)
  const dir = path.dirname(artifactPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(artifactPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8')
  cached = model
  cachedPath = artifactPath
  return artifactPath
}
