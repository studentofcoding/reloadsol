import { NextRequest, NextResponse, connection } from 'next/server'
import { COMBINED_SCORE_WEIGHTS } from '@/strategies/combined-score'
import {
  loadCombinedScoreWeights,
  resetCombinedScoreWeights,
  saveCombinedScoreWeights,
} from '@/strategies/combined-score-weights'

export async function GET() {
  await connection()
  try {
    const live = await loadCombinedScoreWeights()
    return NextResponse.json(
      {
        success: true,
        weights: live.weights,
        defaults: { ...COMBINED_SCORE_WEIGHTS },
        source: live.source,
        rule:
          'Each weight must be a finite number ≥ 0 and the set must sum to more than 0. Saved values are renormalized to sum 1 (0.55/0.20/0.15/0.10 and 55/20/15/10 both work). Invalid stored rows fall back to defaults when scoring.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}

type PatchBody = {
  weights?: Record<string, unknown>
  reset?: boolean
}

export async function PATCH(request: NextRequest) {
  await connection()
  try {
    const body = (await request.json()) as PatchBody
    const result = body.reset
      ? await resetCombinedScoreWeights()
      : await saveCombinedScoreWeights(body.weights)

    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 },
      )
    }

    return NextResponse.json(
      {
        success: true,
        weights: result.weights,
        defaults: { ...COMBINED_SCORE_WEIGHTS },
        source: 'stored' as const,
        renormalized: result.renormalized,
        sumBefore: result.sumBefore,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
