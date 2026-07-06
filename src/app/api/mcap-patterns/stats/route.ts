import { NextResponse } from 'next/server'
import { getPatternTrainingStats } from '@/strategies/social/pattern-training-export'
import { patternRules } from '@/strategies/social/mcap-patterns-24h'

export const dynamic = 'force-dynamic'

type PatternArtifactMetaModule = typeof import('@/strategies/pattern-artifact-meta.server')

function getPatternArtifactMeta(): Promise<PatternArtifactMetaModule> {
  return import('@/strategies/pattern-artifact-meta.server')
}

export async function GET() {
  try {
    const stats = await getPatternTrainingStats()
    const patternMeta = await getPatternArtifactMeta()
    const [patternReady, modelVersion, pipeline, model] = await Promise.all([
      patternMeta.getPatternModelReadyFromMeta(),
      patternMeta.getPatternModelVersionFromMeta(),
      patternMeta.getPatternPipelineState(),
      patternMeta.getPatternModelStats(),
    ])

    return NextResponse.json({
      success: true,
      rules: patternRules(),
      ...stats,
      patternModelReady: patternReady,
      patternModelVersion: modelVersion,
      pipeline,
      model,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
