/**
 * Local paper-notch store for buy_bulk strategy `buybulk-datapublic-scout`.
 *
 * Isolated from rh-tape (`rhtape-datapublic-scout`): different storage key,
 * strategy id, and route. Records paper interest only. Does not open
 * sim-track positions, does not call executeBulkBuy / live swap, and does
 * not write trading_records.
 */

import type { ClimateChipLabel } from '@/utils/climateDisplay'
import {
  BUYBULK_DATAPUBLIC_SCOUT_ID,
  canPaperNotchFromClimate,
  mintKey,
  type ScoutCandidate,
  type ScoutChain,
} from '@/utils/data-public-scout'

export const PAPER_NOTCH_STORAGE_KEY =
  `reloadsol:${BUYBULK_DATAPUBLIC_SCOUT_ID}:paper-notches` as const
export const PAPER_NOTCH_SOURCE = BUYBULK_DATAPUBLIC_SCOUT_ID

export type PaperNotch = {
  key: string
  strategyId: typeof BUYBULK_DATAPUBLIC_SCOUT_ID
  chain: ScoutChain
  mint: string
  symbol: string
  name: string
  kind: string
  decision: string | null
  score: number | null
  notedAt: number
  climateLabel: ClimateChipLabel
  climateState?: string | null
  climateAtEmitLabel?: ClimateChipLabel | null
  source: typeof PAPER_NOTCH_SOURCE
}

export type PaperNotchAttempt =
  | { ok: true; notch: PaperNotch; notches: PaperNotch[] }
  | { ok: false; reason: 'climate_not_safe' | 'missing_mint' | 'duplicate'; notches: PaperNotch[] }

export function emptyPaperNotches(): PaperNotch[] {
  return []
}

export function parsePaperNotches(raw: unknown): PaperNotch[] {
  if (!Array.isArray(raw)) return []
  const out: PaperNotch[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Partial<PaperNotch>
    if (row.chain !== 'robinhood' && row.chain !== 'solana') continue
    if (typeof row.mint !== 'string' || !row.mint.trim()) continue
    if (row.strategyId != null && row.strategyId !== BUYBULK_DATAPUBLIC_SCOUT_ID) continue
    const key = typeof row.key === 'string' && row.key ? row.key : mintKey(row.chain, row.mint)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
      chain: row.chain,
      mint: row.mint,
      symbol: typeof row.symbol === 'string' ? row.symbol : row.mint.slice(0, 6),
      name: typeof row.name === 'string' ? row.name : row.symbol || row.mint.slice(0, 6),
      kind: typeof row.kind === 'string' ? row.kind : 'vetted',
      decision: typeof row.decision === 'string' || row.decision === null ? row.decision : null,
      score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
      notedAt: typeof row.notedAt === 'number' && Number.isFinite(row.notedAt) ? row.notedAt : 0,
      climateLabel: row.climateLabel === 'Safe' ? 'Safe' : row.climateLabel === 'Not safe' ? 'Not safe' : 'Unknown',
      climateState: typeof row.climateState === 'string' ? row.climateState : null,
      climateAtEmitLabel:
        row.climateAtEmitLabel === 'Safe' ||
        row.climateAtEmitLabel === 'Not safe' ||
        row.climateAtEmitLabel === 'Unknown'
          ? row.climateAtEmitLabel
          : null,
      source: PAPER_NOTCH_SOURCE,
    })
  }
  return out.sort((a, b) => b.notedAt - a.notedAt)
}

export function tryAddPaperNotch(
  notches: PaperNotch[],
  candidate: Pick<ScoutCandidate, 'chain' | 'mint' | 'symbol' | 'name' | 'kind' | 'decision' | 'score'>,
  climate: {
    label: ClimateChipLabel | string | null | undefined
    state?: string | null
    emitLabel?: ClimateChipLabel | null
  },
  now = Date.now(),
): PaperNotchAttempt {
  if (!canPaperNotchFromClimate(climate.label)) {
    return { ok: false, reason: 'climate_not_safe', notches }
  }
  const mint = candidate.mint?.trim() ?? ''
  if (!mint) return { ok: false, reason: 'missing_mint', notches }
  const key = mintKey(candidate.chain, mint)
  if (notches.some((n) => n.key === key)) {
    return { ok: false, reason: 'duplicate', notches }
  }
  const notch: PaperNotch = {
    key,
    strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
    chain: candidate.chain,
    mint,
    symbol: candidate.symbol,
    name: candidate.name,
    kind: candidate.kind,
    decision: candidate.decision,
    score: candidate.score,
    notedAt: now,
    climateLabel: 'Safe',
    climateState: climate.state ?? null,
    climateAtEmitLabel: climate.emitLabel ?? 'Safe',
    source: PAPER_NOTCH_SOURCE,
  }
  return { ok: true, notch, notches: [notch, ...notches] }
}

export function readPaperNotchesFromStorage(storage?: Pick<Storage, 'getItem'> | null): PaperNotch[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(PAPER_NOTCH_STORAGE_KEY)
    if (!raw) return []
    return parsePaperNotches(JSON.parse(raw))
  } catch {
    return []
  }
}

export function writePaperNotchesToStorage(
  notches: PaperNotch[],
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  if (!storage) return
  storage.setItem(PAPER_NOTCH_STORAGE_KEY, JSON.stringify(notches))
}
