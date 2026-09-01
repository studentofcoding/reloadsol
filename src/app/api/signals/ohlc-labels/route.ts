import { NextRequest, NextResponse, connection } from 'next/server'
import { listSignalOhlcLabels } from '@/strategies/signal-ohlc-labels'
import type { SignalOhlcLabelKind } from '@/strategies/signal-ohlc-window'


export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const labelRaw = searchParams.get('label')?.trim()
    const label =
      labelRaw === 'potential' || labelRaw === 'rug'
        ? (labelRaw as SignalOhlcLabelKind)
        : null
    const limit = Number(searchParams.get('limit') ?? 50)
    const offset = Number(searchParams.get('offset') ?? 0)

    const rows = await listSignalOhlcLabels({
      label,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    })

    return NextResponse.json(
      { success: true, entries: rows },
      {
        headers: {
          // Client + Redis hold the 10m pattern cache; allow short browser reuse
          'Cache-Control': 'private, max-age=60',
        },
      },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        entries: [],
      },
      { status: 500 },
    )
  }
}
