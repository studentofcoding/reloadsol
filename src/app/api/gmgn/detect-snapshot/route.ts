import { NextRequest, NextResponse } from 'next/server'
import {
  captureDetectSnapshot,
  fetchLastOhlcRugBars,
  getLatestDetectSnapshot,
  insertDetectSnapshot,
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

    // Live bars first — DB snapshot must not block Freeview rules
    const { bars } = await fetchLastOhlcRugBars(address)
    const evalResult = evaluateOhlcRugRules(bars)

    let existing: Awaited<ReturnType<typeof getLatestDetectSnapshot>> = null
    try {
      existing = await getLatestDetectSnapshot(address)
    } catch (err) {
      console.warn('[detect-snapshot] getLatest failed', {
        mint: address,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    let snapshotId = existing?.id ?? null
    let detectedAt = existing?.detected_at ?? null
    let snapSource = existing?.source ?? null
    if ((!existing || existing.bars.length === 0) && bars.length > 0) {
      try {
        snapshotId = await insertDetectSnapshot({
          tokenAddress: address,
          source: 'freeview',
          bars,
          evalResult,
        })
        detectedAt = new Date().toISOString()
        snapSource = 'freeview'
      } catch (err) {
        console.warn('[detect-snapshot] insert failed', {
          mint: address,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

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
        snapshot_id: snapshotId,
        detected_at: detectedAt,
        source: snapSource,
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
      tokenSymbol?: string | null
    }
    const address = body.address?.trim() ?? ''
    if (!address || !isValidMintAddress(address)) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required' },
        { status: 400 },
      )
    }
    const label = body.rug_label
    if (label !== 'rug' && label !== 'potential' && label !== 'system') {
      return NextResponse.json(
        { success: false, error: 'rug_label must be system|rug|potential' },
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

    // Sync global potential / rug lists (best-effort)
    try {
      if (label === 'rug') {
        const { markTokenRug } = await import('@/utils/rug-list/service')
        await markTokenRug({
          tokenAddress: address,
          tokenSymbol: body.tokenSymbol ?? null,
          source: 'freeview',
        })
      } else if (label === 'potential') {
        const { markTokenPotential } = await import(
          '@/utils/potential-list/service'
        )
        await markTokenPotential({
          tokenAddress: address,
          tokenSymbol: body.tokenSymbol ?? null,
          source: 'dlmm-general',
        })
      } else {
        const { unmarkTokenRug } = await import('@/utils/rug-list/service')
        const { unmarkTokenPotential } = await import(
          '@/utils/potential-list/service'
        )
        await unmarkTokenRug(address).catch(() => undefined)
        await unmarkTokenPotential(address).catch(() => undefined)
      }
    } catch (err) {
      console.warn('[detect-snapshot] list sync failed', {
        mint: address,
        label,
        error: err instanceof Error ? err.message : String(err),
      })
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
