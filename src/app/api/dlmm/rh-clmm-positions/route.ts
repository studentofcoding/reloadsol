import { NextRequest, NextResponse, connection } from 'next/server'
import { rejectWrongNetwork } from '@/utils/app-network-api'
import { DbUnavailableError } from '@/utils/db-health'
import { isDlmmApiAuthorized } from '@/utils/dlmm/config'
import {
  getRhClmmPosition,
  insertRhClmmPosition,
  listRhClmmPositions,
  updateRhClmmPosition,
} from '@/utils/dlmm/rh-clmm-db'
import { invalidateRhClmmLiveCache } from '@/utils/dlmm/rh-clmm-live'
import { getDlmmDbStatus } from '@/utils/dlmm/db-status'

function getPassword(req: NextRequest): string | null {
  return (
    req.headers.get('x-dlmm-password') ||
    new URL(req.url).searchParams.get('password')
  )
}

export async function GET(req: NextRequest) {
  await connection()
  const wrong = rejectWrongNetwork(req, 'robinhood')
  if (wrong) return wrong
  try {
    const url = new URL(req.url)
    const status = url.searchParams.get('status') ?? undefined
    const owner = url.searchParams.get('owner') ?? undefined
    const [positions, dbStatus] = await Promise.all([
      listRhClmmPositions(status, owner),
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
  const wrong = rejectWrongNetwork(req, 'robinhood')
  if (wrong) return wrong
  try {
    if (!isDlmmApiAuthorized(getPassword(req))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const body = await req.json()
    const protocol = body.protocol === 'v4' ? 'v4' : 'v3'
    const rawKey = body.pool_key
    const pool_key =
      rawKey &&
      typeof rawKey === 'object' &&
      typeof rawKey.currency0 === 'string' &&
      typeof rawKey.currency1 === 'string' &&
      Number.isFinite(Number(rawKey.fee)) &&
      Number.isFinite(Number(rawKey.tickSpacing)) &&
      typeof rawKey.hooks === 'string'
        ? {
            currency0: String(rawKey.currency0),
            currency1: String(rawKey.currency1),
            fee: Number(rawKey.fee),
            tickSpacing: Number(rawKey.tickSpacing),
            hooks: String(rawKey.hooks),
          }
        : null
    const position = await insertRhClmmPosition({
      token_id: String(body.token_id ?? ''),
      protocol,
      pool_address: String(body.pool_address ?? ''),
      pair_label: body.pair_label != null ? String(body.pair_label) : null,
      token_address:
        body.token_address != null ? String(body.token_address) : null,
      deposit_symbol:
        body.deposit_symbol != null ? String(body.deposit_symbol) : null,
      owner_address: String(body.owner_address ?? ''),
      entry_value_usd: Number(body.entry_value_usd) || 0,
      current_value_usd:
        Number(body.current_value_usd) || Number(body.entry_value_usd) || 0,
      mint_tx: body.mint_tx != null ? String(body.mint_tx) : null,
      status: 'open',
      pool_id: body.pool_id != null ? String(body.pool_id) : null,
      pool_key,
      fee: body.fee != null && Number.isFinite(Number(body.fee)) ? Number(body.fee) : null,
      tick_spacing:
        body.tick_spacing != null && Number.isFinite(Number(body.tick_spacing))
          ? Number(body.tick_spacing)
          : null,
    })
    await invalidateRhClmmLiveCache(position.owner_address)
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

    const existing = await getRhClmmPosition(id)
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const position = await updateRhClmmPosition(id, {
      status: body.status === 'closed' ? 'closed' : body.status,
      close_tx: body.close_tx != null ? String(body.close_tx) : undefined,
      closed_at:
        body.status === 'closed' ? new Date().toISOString() : body.closed_at,
      entry_value_usd:
        body.entry_value_usd != null
          ? Number(body.entry_value_usd)
          : undefined,
      current_value_usd:
        body.current_value_usd != null
          ? Number(body.current_value_usd)
          : undefined,
      pnl_pct: body.pnl_pct != null ? Number(body.pnl_pct) : undefined,
    })
    await invalidateRhClmmLiveCache(position.owner_address)
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
