import { NextRequest, NextResponse } from 'next/server'
import {
  loadOutcomesForMlDataset,
  updateStrategyOutcomeFeatures,
} from '@/strategies/db'
import {
  extractMlFeatureVectorV1,
  isVolumeImputed,
  listIncompleteMlFields,
} from '@/strategies/ml-training-features'
import {
  buildFullEntryFeatureSnapshot,
  mergeNullCoreFeatures,
} from '@/strategies/resolve-entry-snapshot'
import { requireDevSession } from '@/utils/api-auth'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import type { StrategyDomain } from '@/strategies/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function getMlSecret(): string {
  return (
    process.env.MCAP_TRACKER_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

function isBackfillAuthorized(request: NextRequest): NextResponse | null {
  const key = request.nextUrl.searchParams.get('key')
  if (process.env.NODE_ENV === 'development' && !key) {
    return null
  }
  if (isAuthorizedRequest(key, getMlSecret())) {
    return null
  }
  const devAuth = requireDevSession(request)
  if (devAuth instanceof NextResponse) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

function volumeFromMonitorSnapshots(
  features: Record<string, unknown>,
): number | null {
  const snaps = features.monitor_snapshots
  if (!Array.isArray(snaps)) return null
  for (const s of snaps) {
    if (!s || typeof s !== 'object') continue
    const v = (s as { volume_5m?: unknown }).volume_5m
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return null
}

function classifyVolumeFill(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const beforeVol =
    typeof before.volume_at_entry === 'number'
      ? before.volume_at_entry
      : typeof before.volume_5m === 'number'
        ? before.volume_5m
        : null
  const afterVol =
    typeof after.volume_at_entry === 'number'
      ? after.volume_at_entry
      : typeof after.volume_5m === 'number'
        ? after.volume_5m
        : null
  if (beforeVol != null || afterVol == null) {
    if (afterVol == null) return 'imputed'
    return 'unchanged'
  }
  const src = after.volume_at_entry_source
  if (src === 'dexscreener') return 'dexscreener'
  if (src === 'jupiter') {
    const w = after.volume_at_entry_window
    return typeof w === 'string' ? `jupiter_${w}` : 'jupiter'
  }
  if (src === 'monitor' || src === 'tracker' || src === 'mcap_tracking') return String(src)
  if (volumeFromMonitorSnapshots(before) != null && afterVol != null) return 'monitor'
  return 'filled'
}

/**
 * Best-effort: for labeled outcomes with incomplete V1 features, rebuild from
 * Jupiter/DexScreener/tracker and fill only null core fields.
 */
export async function POST(request: NextRequest) {
  const authError = isBackfillAuthorized(request)
  if (authError) return authError

  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain') as StrategyDomain | null
    const strategyId = searchParams.get('strategyId') ?? undefined
    const dryRun = searchParams.get('dry_run') === 'true'
    const limit = Math.min(
      Math.max(parseInt(searchParams.get('limit') ?? '15', 10) || 15, 1),
      200,
    )

    const rows = await loadOutcomesForMlDataset({
      domain: domain ?? undefined,
      strategyId,
    })

    // Prefer rows that still fail required fields; also include volume-imputed
    // candidates so we can enrich real volume when sources have data.
    const incomplete = rows.filter((row) => {
      if (!row.entry_at) return false
      const missing = listIncompleteMlFields(row.features, row.domain, {
        entryAt: row.entry_at,
      })
      if (missing.length > 0) return true
      return isVolumeImputed(row.features, row.domain, { entryAt: row.entry_at })
    })

    let scanned = 0
    let updated = 0
    let stillIncomplete = 0
    let skippedNoMint = 0
    let volumeEnriched = 0
    const volumeFilledFrom: Record<string, number> = {}
    const postMergeSample: { id: string; missing: string[]; volume_filled_from: string }[] =
      []
    const errors: string[] = []

    for (const row of incomplete.slice(0, limit)) {
      scanned += 1
      const mint = row.token_address?.trim()
      const mintFromFeatures =
        typeof row.features?.mint_address === 'string'
          ? row.features.mint_address
          : null
      if (row.domain === 'dlmm' && !mintFromFeatures && (!mint || mint.length < 32)) {
        skippedNoMint += 1
        continue
      }

      const tokenMint = mintFromFeatures || mint
      if (!tokenMint) {
        skippedNoMint += 1
        continue
      }

      try {
        const existing = { ...(row.features ?? {}) }
        const monitorVol = volumeFromMonitorSnapshots(existing)
        if (
          (existing.volume_at_entry == null ||
            (typeof existing.volume_at_entry === 'number' &&
              !Number.isFinite(existing.volume_at_entry))) &&
          monitorVol != null
        ) {
          existing.volume_at_entry = monitorVol
          existing.volume_5m = monitorVol
          existing.volume_at_entry_source = 'monitor'
        }

        const rebuilt = await buildFullEntryFeatureSnapshot(tokenMint, {
          entryAt: row.entry_at,
          firstSeenAt:
            typeof existing.first_seen_at === 'string'
              ? existing.first_seen_at
              : null,
          entryMcap:
            typeof existing.entry_mcap === 'number'
              ? existing.entry_mcap
              : typeof existing.first_mcap === 'number'
                ? existing.first_mcap
                : null,
          volume5m:
            typeof existing.volume_at_entry === 'number'
              ? existing.volume_at_entry
              : null,
          tokenSymbol:
            typeof existing.token_symbol === 'string'
              ? existing.token_symbol
              : null,
        })
        const merged = mergeNullCoreFeatures(existing, rebuilt)
        const fill = classifyVolumeFill(row.features ?? {}, merged)
        volumeFilledFrom[fill] = (volumeFilledFrom[fill] ?? 0) + 1
        if (fill !== 'imputed' && fill !== 'unchanged') volumeEnriched += 1

        const complete =
          extractMlFeatureVectorV1(merged, row.domain, {
            entryAt: row.entry_at,
          }) != null
        const missingAfter = listIncompleteMlFields(merged, row.domain, {
          entryAt: row.entry_at,
        })

        if (postMergeSample.length < 5) {
          postMergeSample.push({
            id: row.id,
            missing: missingAfter,
            volume_filled_from: fill,
          })
        }

        if (!dryRun) {
          const result = await updateStrategyOutcomeFeatures(row.id, merged)
          if (!result.ok) {
            errors.push(`${row.id}: ${result.error ?? 'update failed'}`)
            continue
          }
        }

        if (complete) updated += 1
        else stillIncomplete += 1
      } catch (err) {
        errors.push(
          `${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      await new Promise((r) => setTimeout(r, 250))
    }

    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      incomplete_total: incomplete.length,
      scanned,
      updated,
      still_incomplete: stillIncomplete,
      skipped_no_mint: skippedNoMint,
      volume_enriched: volumeEnriched,
      volume_filled_from: volumeFilledFrom,
      sample_missing_fields: postMergeSample,
      errors: errors.slice(0, 20),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
