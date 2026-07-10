import { NextRequest, NextResponse } from 'next/server'
import {
  loadOutcomesForMlDataset,
  updateStrategyOutcomeFeatures,
} from '@/strategies/db'
import {
  extractMlFeatureVectorV1,
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

/**
 * Best-effort: for labeled outcomes with incomplete V1 features, rebuild from
 * Jupiter/tracker and fill only null core fields.
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
      Math.max(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 1),
      200,
    )

    const rows = await loadOutcomesForMlDataset({
      domain: domain ?? undefined,
      strategyId,
    })

    const incomplete = rows.filter(
      (row) =>
        row.entry_at &&
        extractMlFeatureVectorV1(row.features, row.domain, {
          entryAt: row.entry_at,
        }) == null,
    )

    let scanned = 0
    let updated = 0
    let stillIncomplete = 0
    let skippedNoMint = 0
    const errors: string[] = []

    for (const row of incomplete.slice(0, limit)) {
      scanned += 1
      const mint = row.token_address?.trim()
      if (!mint || (row.domain === 'dlmm' && !row.features?.mint_address && mint.length < 32)) {
        // pool-only dlmm without mint
        const mintFromFeatures =
          typeof row.features?.mint_address === 'string'
            ? row.features.mint_address
            : null
        if (!mintFromFeatures && row.domain === 'dlmm') {
          skippedNoMint += 1
          continue
        }
      }

      const tokenMint =
        (typeof row.features?.mint_address === 'string' && row.features.mint_address) ||
        mint
      if (!tokenMint) {
        skippedNoMint += 1
        continue
      }

      try {
        const rebuilt = await buildFullEntryFeatureSnapshot(tokenMint, {
          entryAt: row.entry_at,
          firstSeenAt:
            typeof row.features?.first_seen_at === 'string'
              ? row.features.first_seen_at
              : null,
          entryMcap:
            typeof row.features?.entry_mcap === 'number'
              ? row.features.entry_mcap
              : typeof row.features?.first_mcap === 'number'
                ? row.features.first_mcap
                : null,
          tokenSymbol:
            typeof row.features?.token_symbol === 'string'
              ? row.features.token_symbol
              : null,
        })
        const merged = mergeNullCoreFeatures(row.features ?? {}, rebuilt)
        const complete =
          extractMlFeatureVectorV1(merged, row.domain, {
            entryAt: row.entry_at,
          }) != null

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

      // Light rate-limit for Jupiter
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
      sample_missing_fields:
        incomplete.slice(0, 5).map((row) => ({
          id: row.id,
          missing: listIncompleteMlFields(row.features, row.domain, {
            entryAt: row.entry_at,
          }),
        })),
      errors: errors.slice(0, 20),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
