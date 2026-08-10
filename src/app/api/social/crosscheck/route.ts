import { NextRequest, NextResponse } from 'next/server'
import { listSignalPriceCrosschecks } from '@/strategies/social/crosscheck-db'
import { runSignalCrosscheck } from '@/strategies/social/run-crosscheck'
import { isSocialIngestAuthorized } from '@/utils/social/config'

export const maxDuration = 60

function isAuthorized(request: NextRequest): boolean {
  const key =
    request.nextUrl.searchParams.get('key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  return isSocialIngestAuthorized(key)
}

export async function GET(request: NextRequest) {
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 50)
  const hours = Number(request.nextUrl.searchParams.get('hours') ?? 48)
  const status = request.nextUrl.searchParams.get('status') ?? undefined
  const channelName = request.nextUrl.searchParams.get('channel_name') ?? undefined

  const rows = await listSignalPriceCrosschecks({
    limit,
    hours,
    status,
    channelName,
  })

  return NextResponse.json({ success: true, crosschecks: rows })
}

export async function POST(request: NextRequest) {
  const fromTelethon = isAuthorized(request)

  try {
    const body = (await request.json()) as {
      raw_message?: string
      channel_name?: string
      channel_id?: string
      cluster_name?: string
      tolerance_pct?: number
      external_message_id?: string
      occurred_at?: string
      skip_sim?: boolean
      events?: Array<{
        raw_message?: string
        channel_id?: string
        external_message_id?: string
        occurred_at?: string
      }>
    }

    if (Array.isArray(body.events)) {
      if (!fromTelethon) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }

      const results = []
      for (const event of body.events) {
        if (!event.raw_message) continue
        const result = await runSignalCrosscheck({
          raw_message: event.raw_message,
          channel_id: event.channel_id ?? null,
          external_message_id: event.external_message_id ?? null,
          occurred_at: event.occurred_at,
        })
        results.push(result)
      }

      return NextResponse.json({ success: true, results })
    }

    if (!body.raw_message?.trim()) {
      return NextResponse.json(
        { success: false, error: 'raw_message is required' },
        { status: 400 },
      )
    }

    if (fromTelethon && body.channel_id && !body.channel_name) {
      // Telethon path — channel_name resolved from DB
    } else if (!body.channel_name?.trim()) {
      return NextResponse.json(
        { success: false, error: 'channel_name is required (manual input)' },
        { status: 400 },
      )
    }

    const result = await runSignalCrosscheck({
      raw_message: body.raw_message,
      channel_name: body.channel_name,
      channel_id: body.channel_id ?? null,
      cluster_name: body.cluster_name,
      tolerance_pct: body.tolerance_pct,
      external_message_id: body.external_message_id ?? null,
      occurred_at: body.occurred_at,
      skip_sim: body.skip_sim,
    })

    if (!result.ok && !result.row) {
      return NextResponse.json(
        { success: false, error: result.error, parsed: result.parsed },
        { status: result.error?.includes('required') ? 400 : 500 },
      )
    }

    return NextResponse.json({
      success: result.ok,
      error: result.error,
      crosscheck: result.row,
      parsed: result.parsed,
      strategyId: result.strategyId,
      simOpened: result.simOpened,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
