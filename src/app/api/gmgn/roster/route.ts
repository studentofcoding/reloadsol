import { NextRequest, NextResponse, connection } from 'next/server'
import {
  buildScoreParts,
  listDigHitsForWallets,
  listRecentConcurrenceSignals,
  listRecentDigRuns,
  listRoster,
  patchRoster,
  type FollowStatus,
  type RosterStatus,
} from '@/strategies/wallet-digger/db'


export async function GET(request: NextRequest) {
  try {
    await connection()
    const status = request.nextUrl.searchParams.get('status') as RosterStatus | null
    const [roster, digRuns, signals] = await Promise.all([
      listRoster(status ? { status, limit: 300 } : { limit: 300 }),
      listRecentDigRuns(20),
      listRecentConcurrenceSignals(50),
    ])

    const hitsByWallet = await listDigHitsForWallets(roster.map((r) => r.address))

    const enriched = roster.map((row) => {
      const hit_tokens = hitsByWallet[row.address] ?? []
      const score_parts = buildScoreParts({
        runnerHits: row.runner_hits,
        score: row.score,
        hitTokens: hit_tokens,
      })
      return { ...row, hit_tokens, score_parts }
    })

    return NextResponse.json({
      success: true,
      roster: enriched,
      digRuns,
      signals,
      needsFollow: enriched.filter(
        (r) => r.status === 'needs_follow' || r.follow_status === 'needs_follow',
      ),
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

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      address?: string
      status?: RosterStatus
      follow_status?: FollowStatus
      notes?: string | null
    }
    if (!body.address?.trim()) {
      return NextResponse.json(
        { success: false, error: 'address required' },
        { status: 400 },
      )
    }
    const row = await patchRoster(body.address.trim(), {
      status: body.status,
      follow_status: body.follow_status,
      notes: body.notes,
    })
    if (!row) {
      return NextResponse.json({ success: false, error: 'not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true, row })
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
