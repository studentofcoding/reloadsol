import { NextRequest, NextResponse } from 'next/server'
import {
  captureDetectSnapshot,
  fetchLastOhlcRugBars,
  getLatestDetectSnapshot,
  updateDetectSnapshotLabel,
  type DetectRugLabel,
} from '@/strategies/detect-snapshots'
import { evaluateOhlcRugRules } from '@/strategies/ohlc-rug-rules'
import { isValidMintAddress } from '@/utils/jupiter'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim() ?? ''
    if (!address || !isValidMintAddress(address)) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required' },
        { status: 400 },
      )
    }

    const [existing, { bars }] = await Promise.all([
      getLatestDetectSnapshot(address),
      fetchLastOhlcRugBars(address),
    ])
    const evalResult = evaluateOhlcRugRules(bars)

    return NextResponse.json(
      {
        success: true,
        address,
        bars,
        barCount: bars.length,
        features: evalResult.features,
        rule_hits: evalResult.hits,
        trip: evalResult.trip,
        rug_label: existing?.rug_label ?? 'system',
        snapshot_id: existing?.id ?? null,
        detected_at: existing?.detected_at ?? null,
        source: existing?.source ?? null,
        frozen_features: existing?.features ?? null,
        frozen_rule_hits: existing?.rule_hits ?? null,
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

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      address?: string
      rug_label?: DetectRugLabel
    }
    const address = body.address?.trim() ?? ''
    if (!address || !isValidMintAddress(address)) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required' },
        { status: 400 },
      )
    }
    const label = body.rug_label
    if (label !== 'rug' && label !== 'not_rug' && label !== 'system') {
      return NextResponse.json(
        { success: false, error: 'rug_label must be system|rug|not_rug' },
        { status: 400 },
      )
    }

    let updated = await updateDetectSnapshotLabel(address, label)
    if (!updated) {
      await captureDetectSnapshot({
        tokenAddress: address,
        source: 'freeview',
      })
      updated = await updateDetectSnapshotLabel(address, label)
    }

    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'No snapshot to label' },
        { status: 404 },
      )
    }

    return NextResponse.json({
      success: true,
      snapshot_id: updated.id,
      rug_label: updated.rug_label,
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
