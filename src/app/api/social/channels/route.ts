import { NextRequest, NextResponse } from 'next/server'
import {
  deleteTelegramSignalChannel,
  listTelegramSignalChannels,
  upsertTelegramSignalChannel,
} from '@/strategies/social/crosscheck-db'
import { slugify } from '@/strategies/social/crosscheck-slug'


export async function GET() {
  const channels = await listTelegramSignalChannels(false)
  return NextResponse.json({ success: true, channels })
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      id?: string
      channel_name?: string
      channel_id?: string | null
      cluster_name?: string
      dex_default?: string | null
      tolerance_pct?: number
      sim_buy_sol?: number
      is_active?: boolean
    }

    if (!body.channel_name?.trim()) {
      return NextResponse.json(
        { success: false, error: 'channel_name is required' },
        { status: 400 },
      )
    }

    const id = body.id?.trim() || slugify(body.channel_name)
    const result = await upsertTelegramSignalChannel({
      id,
      channel_name: body.channel_name.trim(),
      channel_id: body.channel_id ?? null,
      cluster_name: body.cluster_name,
      dex_default: body.dex_default ?? null,
      tolerance_pct: body.tolerance_pct,
      sim_buy_sol: body.sim_buy_sol,
      is_active: body.is_active,
    })

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    }

    return NextResponse.json({ success: true, id })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ success: false, error: 'id required' }, { status: 400 })
  }
  const ok = await deleteTelegramSignalChannel(id)
  return NextResponse.json({ success: ok })
}
