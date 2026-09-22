/**
 * One-shot planner for token_mcap_tracking labels.
 * Uses live applyAutoLabelsFromMilestones — does not copy the predicate
 * and does not write dlmm_potential_list / token_rug_list.
 */
import {
  applyAutoLabelsFromMilestones,
  reconcileMilestonesFromGrowth,
  type McapSnapshot,
  type TokenLabel,
} from '@/utils/mcap-tracker'

export const MCAP_LABEL_BACKFILL_OHLC_CONCURRENCY = 3

export type McapLabelBackfillPlan = {
  /** Label, drop stamps, or peak fields differ from the loaded row. */
  persist: boolean
  /** Current label is potential or rugged (changed or already). */
  capture: boolean
  labelChanged: boolean
}

export type McapLabelBackfillCounts = {
  scanned: number
  label_updated: number
  label_unchanged: number
  ohlc_captured: number
  ohlc_existing: number
  ohlc_failed: number
  ohlc_potential_total: number
  ohlc_rug_total: number
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asIso(v: unknown): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) {
    const ms = v.getTime()
    return Number.isFinite(ms) ? v.toISOString() : null
  }
  if (typeof v === 'string') return v
  return null
}

function labelOf(v: TokenLabel | null | undefined): TokenLabel | null {
  return v ?? null
}

type Comparable = {
  label: TokenLabel | null
  when_drop_40pct: string | null
  when_drop_80pct: string | null
  peak_mcap: number | null
  peak_growth_percent: number | null
  peak_seen_at: string | null
}

function comparable(record: McapSnapshot): Comparable {
  return {
    label: labelOf(record.label),
    when_drop_40pct: asIso(record.when_drop_40pct),
    when_drop_80pct: asIso(record.when_drop_80pct),
    peak_mcap: asNum(record.peak_mcap),
    peak_growth_percent: asNum(record.peak_growth_percent),
    peak_seen_at: asIso(record.peak_seen_at),
  }
}

function same(a: Comparable, b: Comparable): boolean {
  return (
    a.label === b.label &&
    a.when_drop_40pct === b.when_drop_40pct &&
    a.when_drop_80pct === b.when_drop_80pct &&
    a.peak_mcap === b.peak_mcap &&
    a.peak_growth_percent === b.peak_growth_percent &&
    a.peak_seen_at === b.peak_seen_at
  )
}

function coerceRow(record: McapSnapshot): void {
  record.mcap_growth_percent = asNum(record.mcap_growth_percent) ?? 0
  record.current_mcap = asNum(record.current_mcap) ?? record.current_mcap
  record.peak_mcap = asNum(record.peak_mcap)
  record.peak_growth_percent = asNum(record.peak_growth_percent)
  record.peak_seen_at = asIso(record.peak_seen_at)
  record.when_drop_40pct = asIso(record.when_drop_40pct)
  record.when_drop_80pct = asIso(record.when_drop_80pct)
  record.when_reach_80pct = asIso(record.when_reach_80pct)
  record.when_reach_120pct = asIso(record.when_reach_120pct)
  record.when_reach_200pct = asIso(record.when_reach_200pct)
  record.label = labelOf(record.label)
}

/**
 * Soft-overwrite one tracker row in memory.
 * Drop timestamps use `nowIso` when the column was null (no historical clock).
 */
export function planMcapLabelBackfill(
  record: McapSnapshot,
  nowIso: string = new Date().toISOString(),
): McapLabelBackfillPlan {
  coerceRow(record)
  const before = comparable(record)

  reconcileMilestonesFromGrowth(record, nowIso)

  const storedPeak = asNum(record.peak_growth_percent)
  const growth = asNum(record.mcap_growth_percent)
  const peakMissing = storedPeak == null
  // Null peak compares like 0 (`n > null`), so only a positive growth fills it.
  if (peakMissing && growth != null && growth > 0) {
    record.peak_growth_percent = growth
    if (asNum(record.peak_mcap) == null && asNum(record.current_mcap) != null) {
      record.peak_mcap = asNum(record.current_mcap)
    }
    if (!asIso(record.peak_seen_at)) {
      record.peak_seen_at = nowIso
    }
  }

  applyAutoLabelsFromMilestones(record)

  const after = comparable(record)
  const label = labelOf(record.label)
  return {
    persist: !same(before, after),
    capture: label === 'potential' || label === 'rugged',
    labelChanged: before.label !== label,
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Math.min(Math.max(concurrency, 1), items.length)
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const idx = cursor++
        out[idx] = await fn(items[idx]!)
      }
    }),
  )
  return out
}

export async function runMcapLabelBackfill(options: {
  rows: McapSnapshot[]
  dryRun: boolean
  nowIso?: string
  concurrency?: number
  updateRow: (record: McapSnapshot) => Promise<void>
  captureOhlc: (record: McapSnapshot) => Promise<'captured' | 'existing'>
  countOhlcTotals?: () => Promise<{ potential: number; rug: number }>
}): Promise<McapLabelBackfillCounts> {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const concurrency = options.concurrency ?? MCAP_LABEL_BACKFILL_OHLC_CONCURRENCY
  const counts: McapLabelBackfillCounts = {
    scanned: 0,
    label_updated: 0,
    label_unchanged: 0,
    ohlc_captured: 0,
    ohlc_existing: 0,
    ohlc_failed: 0,
    ohlc_potential_total: 0,
    ohlc_rug_total: 0,
  }

  const captureRows: McapSnapshot[] = []

  for (const record of options.rows) {
    counts.scanned += 1
    const plan = planMcapLabelBackfill(record, nowIso)
    if (plan.persist) counts.label_updated += 1
    else counts.label_unchanged += 1

    if (plan.persist && !options.dryRun) {
      await options.updateRow(record)
    }
    if (plan.capture) captureRows.push(record)
  }

  if (!options.dryRun) {
    const results = await mapPool(captureRows, concurrency, async (record) => {
      try {
        return await options.captureOhlc(record)
      } catch {
        return 'failed' as const
      }
    })
    for (const result of results) {
      if (result === 'captured') counts.ohlc_captured += 1
      else if (result === 'existing') counts.ohlc_existing += 1
      else counts.ohlc_failed += 1
    }
  }

  if (options.countOhlcTotals) {
    const totals = await options.countOhlcTotals()
    counts.ohlc_potential_total = totals.potential
    counts.ohlc_rug_total = totals.rug
  }

  return counts
}
