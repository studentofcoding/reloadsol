import { NextRequest, NextResponse, connection } from 'next/server'
import {
  listStrategyReviewNotes,
  upsertStrategyReviewNote,
  upsertStrategyReviewNotesBatch,
} from '@/strategies/strategy-review-notes'


export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const keysRaw = searchParams.get('periodKeys')
    const periodKeys = keysRaw
      ? keysRaw.split(',').map((k) => k.trim()).filter(Boolean)
      : undefined
    const notes = await listStrategyReviewNotes({ periodKeys })
    return NextResponse.json({ success: true, notes })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        notes: {},
      },
      { status: 500 },
    )
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      periodKey?: string
      note?: string
      notes?: Record<string, string>
    }

    // Batch migrate / sync
    if (body.notes && typeof body.notes === 'object') {
      const count = await upsertStrategyReviewNotesBatch(body.notes)
      const notes = await listStrategyReviewNotes()
      return NextResponse.json({ success: true, migrated: count, notes })
    }

    if (!body.periodKey) {
      return NextResponse.json(
        { success: false, error: 'periodKey or notes required' },
        { status: 400 },
      )
    }

    const result = await upsertStrategyReviewNote(
      body.periodKey,
      body.note ?? '',
    )
    return NextResponse.json({ success: true, ...result })
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
