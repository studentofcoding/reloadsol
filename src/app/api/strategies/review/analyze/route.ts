import { NextRequest, NextResponse } from 'next/server'
import {
  heuristicReviewPatterns,
  type StrategyReviewPayload,
} from '@/strategies/strategy-review'

export const dynamic = 'force-dynamic'

async function anthropicPatterns(
  review: StrategyReviewPayload,
  notesByWeek: Record<string, string>,
): Promise<string[] | null> {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (!key) return null

  const compact = {
    period: review.periodSummary,
    streaks: review.streaks.slice(0, 10),
    best: review.scorecard.best,
    worst: review.scorecard.worst,
    notesByWeek,
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_REVIEW_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [
        {
          role: 'user',
          content: `You are a trading process coach. From this strategy review JSON, return ONLY a JSON array of 3-5 short strings: strongest patterns, especially contradictions between improvement notes and later loss streaks.\n\n${JSON.stringify(compact)}`,
        },
      ],
    }),
  })

  if (!res.ok) return null
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>
  }
  const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.map(String).slice(0, 5)
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      review?: StrategyReviewPayload
      notesByWeek?: Record<string, string>
    }
    if (!body.review) {
      return NextResponse.json(
        { success: false, error: 'review required' },
        { status: 400 },
      )
    }

    const notes = body.notesByWeek ?? {}
    const llm = await anthropicPatterns(body.review, notes)
    const patterns = llm ?? heuristicReviewPatterns(body.review, notes)

    return NextResponse.json({
      success: true,
      source: llm ? 'anthropic' : 'heuristic',
      patterns,
    })
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
