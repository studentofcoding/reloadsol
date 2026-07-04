import { NextResponse } from 'next/server'
import { getPatternTrainingStats } from '@/strategies/social/pattern-training-export'
import { patternRules } from '@/strategies/social/mcap-patterns-24h'
import { getPatternModelReady, getPatternModelVersion } from '@/strategies/entry-pattern-scorer.server'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const stats = await getPatternTrainingStats()
    const [patternReady, modelVersion] = await Promise.all([
      getPatternModelReady(),
      getPatternModelVersion(),
    ])

    return NextResponse.json({
      success: true,
      rules: patternRules(),
      ...stats,
      patternModelReady: patternReady,
      patternModelVersion: modelVersion,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
