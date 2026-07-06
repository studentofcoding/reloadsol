import { NextResponse } from 'next/server'
import { getPatternTrainingStats } from '@/strategies/social/pattern-training-export'
import { patternRules } from '@/strategies/social/mcap-patterns-24h'
import {
  getPatternModelReadyFromMeta,
  getPatternModelStats,
  getPatternModelVersionFromMeta,
  getPatternPipelineState,
} from '@/strategies/pattern-artifact-meta.server'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const stats = await getPatternTrainingStats()
    const [patternReady, modelVersion, pipeline, model] = await Promise.all([
      getPatternModelReadyFromMeta(),
      getPatternModelVersionFromMeta(),
      getPatternPipelineState(),
      getPatternModelStats(),
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
