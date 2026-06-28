import { NextRequest, NextResponse } from 'next/server'
import {
  listMarketRegimeTags,
  loadRegimeTagForDate,
  upsertMarketRegimeTag,
} from '@/strategies/db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    if (date) {
      const tag = await loadRegimeTagForDate(date)
      return NextResponse.json({ success: true, date, regime_tag: tag })
    }
    const tags = await listMarketRegimeTags()
    return NextResponse.json({ success: true, tags })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      tag_date?: string
      regime_tag?: string
      notes?: string | null
    }
    if (!body.tag_date || !body.regime_tag) {
      return NextResponse.json(
        { success: false, error: 'tag_date and regime_tag required' },
        { status: 400 },
      )
    }
    const result = await upsertMarketRegimeTag({
      tagDate: body.tag_date,
      regimeTag: body.regime_tag,
      notes: body.notes ?? null,
    })
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
