import { NextRequest, NextResponse } from 'next/server'
import { DbUnavailableError } from '@/utils/db-health'
import { isDlmmApiAuthorized } from '@/utils/dlmm/config'
import {
  insertRhUniv2Position,
  listRhUniv2Positions,
  updateRhUniv2Position,
  getRhUniv2Position,
} from '@/utils/dlmm/rh-univ2-db'
import { markRhUniv2Position } from '@/utils/dlmm/rh-univ2-mark'
import { getDlmmDbStatus } from '@/utils/dlmm/db-status'

function getPassword(req: NextRequest): string | null {
  return (
    req.headers.get('x-dlmm-password') ||
    new URL(req.url).searchParams.get('password')
  )
}

export async function GET(req: NextRequest) {
  try {
    const status = new URL(req.url).searchParams.get('status') ?? undefined
    const [positions, dbStatus] = await Promise.all([
      listRhUniv2Positions(status ?? undefined),
      getDlmmDbStatus(),
    ])
    return NextResponse.json({ success: true, positions, dbStatus })
  } catch (error) {
    return NextResponse.json({
      success: true,
      positions: [],
      warning: error instanceof Error ? error.message : 'Partial load failed',
    })
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isDlmmApiAuthorized(getPassword(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body = await req.json()
    const quote = body.quote_symbol === 'WETH' ? 'WETH' : 'USDG'
    const position = await insertRhUniv2Position({
      pool_address: String(body.pool_address ?? ''),
      pair_label: body.pair_label != null ? String(body.pair_label) : null,
      token_address: String(body.token_address ?? ''),
      quote_symbol: quote,
      owner_address: String(body.owner_address ?? ''),
      lp_token_address: String(body.lp_token_address ?? body.pool_address ?? ''),
      entry_quote_amount: Number(body.entry_quote_amount) || 0,
      entry_value_usd: Number(body.entry_value_usd) || 0,
      current_value_usd: Number(body.current_value_usd) || Number(body.entry_value_usd) || 0,
      add_tx: body.add_tx != null ? String(body.add_tx) : null,
      status: 'open',
    })
    return NextResponse.json({ success: true, position })
  } catch (error) {
    if (error instanceof DbUnavailableError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 503 },
      )
    }
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Insert failed',
      },
      { status: 500 },
    )
  }
}

export async function PATCH(req: NextRequest) {
  try {
    if (!isDlmmApiAuthorized(getPassword(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body = await req.json()
    const id = String(body.id ?? '')
    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 })
    }

    if (body.action === 'refresh') {
      const pos = await getRhUniv2Position(id)
      if (!pos) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      const mark = await markRhUniv2Position(pos)
      const position = await updateRhUniv2Position(id, mark)
      return NextResponse.json({ success: true, position })
    }

    if (body.action === 'refresh_all') {
      const open = await listRhUniv2Positions('open')
      const updated = []
      for (const pos of open) {
        try {
          const mark = await markRhUniv2Position(pos)
          updated.push(await updateRhUniv2Position(pos.id, mark))
        } catch (err) {
          console.warn('[rh-univ2] mark failed', pos.id, err)
        }
      }
      return NextResponse.json({ success: true, positions: updated })
    }

    const position = await updateRhUniv2Position(id, {
      status: body.status === 'closed' ? 'closed' : body.status,
      remove_tx: body.remove_tx != null ? String(body.remove_tx) : undefined,
      closed_at:
        body.status === 'closed' ? new Date().toISOString() : body.closed_at,
      current_value_usd:
        body.current_value_usd != null
          ? Number(body.current_value_usd)
          : undefined,
      pnl_pct: body.pnl_pct != null ? Number(body.pnl_pct) : undefined,
    })
    return NextResponse.json({ success: true, position })
  } catch (error) {
    if (error instanceof DbUnavailableError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 503 },
      )
    }
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Update failed',
      },
      { status: 500 },
    )
  }
}
