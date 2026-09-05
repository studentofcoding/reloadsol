import { NextRequest, NextResponse, connection } from 'next/server'
import { getPatternTrainingStats } from '@/strategies/social/pattern-training-export'
import { patternRules } from '@/strategies/social/mcap-patterns-24h'
import { parseDbChain } from '@/utils/app-network-db'


type PatternArtifactMetaModule = typeof import('@/strategies/pattern-artifact-meta.server')

function getPatternArtifactMeta(): Promise<PatternArtifactMetaModule> {
  return import('@/strategies/pattern-artifact-meta.server')
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    const chain = parseDbChain(request.nextUrl.searchParams.get('chain'))
    const stats = await getPatternTrainingStats(chain)
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
      chain,
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
