/**
 * data-public observe + paper-sim for buy_bulk only (S6).
 *
 * Strategy id: `buybulk-datapublic-scout`.
 * Not shared with rh-tape (`rhtape-datapublic-scout`): separate config,
 * notch store, routes, and strategy id. Do not call processFill or touch
 * the rh-tape Worker from this path.
 *
 * Filters the public research feed into paper candidates. Same rules for
 * Robinhood and Solana. Never executes live buys/swaps. Never enables
 * CLIMATE_GATE_LIVE.
 *
 * Paper notches are allowed only when the Header climate *display* label is
 * Safe (Mixed/Range/Hype, no cascade). Not safe / Unknown → observe only.
 */

import type { ClimateChipLabel, ClimateChipPayload } from '@/utils/climateDisplay'

/** Buy-bulk data-public observe + paper-sim. Do not reuse on rh-tape. */
export const BUYBULK_DATAPUBLIC_SCOUT_ID = 'buybulk-datapublic-scout' as const

/**
 * rh-tape's shipped scout id — listed only so buy_bulk never collides.
 * Do not import rh-tape config, notch store, routes, or processFill.
 */
export const RHTAPE_DATAPUBLIC_SCOUT_ID = 'rhtape-datapublic-scout' as const

export const DATA_PUBLIC_FEED_DEFAULT =
  'https://data-public.vercel.app/api/feed'
export const DATA_PUBLIC_STUDY_DISCLAIMER =
  'Study / research only. This public feed is not a live trade signal and never executes buys or swaps.'

export const LIQ_FLOOR_USD = 9_000
/** Obvious ticker-farm reuse (low single-digit reuse is common on families). */
export const COPYCAT_NAME_REUSE = 8
export const COPYCAT_IMAGE_REUSE = 2
export const COPYCAT_REGISTRY_NAME_PRIOR = 8
export const COPYCAT_REGISTRY_COMBO_PRIOR = 5
/** Fresh wallets as a share of the sampled set. */
export const FRESH_RATIO = 0.5

export const SCOUT_CHAINS = ['robinhood', 'solana'] as const
export type ScoutChain = (typeof SCOUT_CHAINS)[number]
export type ScoutChainQuery = ScoutChain | 'all'

export const SCOUT_REJECT_REASONS = [
  'missing_mint',
  'missing_chain',
  'decision',
  'veto',
  'liq',
  'ring',
  'fresh',
  'copycat',
] as const
export type ScoutRejectReason = (typeof SCOUT_REJECT_REASONS)[number]

export type ScoutSightings = {
  n?: number
  spanH?: number
  sources?: number
  surfaced?: number
}

export type ScoutEvmBundle = {
  verdict?: string
  note?: string
  fresh?: number
  n?: number
  cluster?: number
  sharedFunder?: number
}

export type ScoutFeedRow = {
  id?: number | string
  ts?: number
  kind?: string
  chain?: string
  mint?: string
  symbol?: string
  name?: string
  image?: string
  url?: string
  decision?: string | null
  score?: number | null
  mcap?: number | null
  price?: number | null
  liq?: number | null
  liqTotal?: number | null
  ageMin?: number | null
  source?: string | null
  vetoes?: string[] | null
  sightings?: ScoutSightings | null
  socials?: unknown
  rhGrade?: unknown
  evmSecurity?: unknown
  evmBundle?: ScoutEvmBundle | null
  rhFreshWarn?: { fresh?: number; of?: number } | null
  nameReuse?: number | null
  imageReuse?: number | null
  registryReuse?: {
    n?: number
    nameN?: number
    prior?: number
    namePrior?: number
    comboPrior?: number
  } | null
  [key: string]: unknown
}

export type ScoutCandidate = {
  id: string
  ts: number | null
  kind: string
  chain: ScoutChain
  mint: string
  symbol: string
  name: string
  image: string | null
  url: string | null
  decision: string | null
  score: number | null
  mcap: number | null
  liq: number | null
  ageMin: number | null
  source: string | null
  vetoes: string[]
  sightings: ScoutSightings | null
}

export type ScoutFeedMeta = {
  generatedAt: number | null
  solDelayMin: number
  windowH: number | null
  page: number | null
  pages: number | null
  upstreamCounts: Record<string, number> | null
}

export type FilterOutcome =
  | { ok: true; candidate: ScoutCandidate }
  | { ok: false; reason: ScoutRejectReason }

const PREFERRED_DECISIONS = new Set([
  'surfaced',
  'run',
  'runs',
  'revival',
  'revivals',
])

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function normText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function parseScoutChainQuery(raw: unknown): ScoutChainQuery | null {
  const v = normText(raw)
  if (v === 'all' || v === '') return 'all'
  if (v === 'robinhood' || v === 'rh') return 'robinhood'
  if (v === 'solana' || v === 'sol') return 'solana'
  return null
}

export function normalizeScoutChain(raw: unknown): ScoutChain | null {
  const v = normText(raw)
  if (v === 'robinhood' || v === 'rh') return 'robinhood'
  if (v === 'solana' || v === 'sol') return 'solana'
  return null
}

export function mintKey(chain: ScoutChain, mint: string): string {
  return `${chain}:${mint.trim().toLowerCase()}`
}

/** Prefer decision=surfaced plus run/revival kinds (both chains). */
export function isPreferredCandidate(row: ScoutFeedRow): boolean {
  const decision = normText(row.decision)
  if (PREFERRED_DECISIONS.has(decision)) return true
  const kind = normText(row.kind)
  if (!kind) return false
  if (kind === 'rhrun' || kind === 'rhrevival' || kind === 'solrun' || kind === 'solrevival') {
    return true
  }
  if (kind.endsWith('run') || kind.endsWith('revival')) return true
  if (kind.includes('revival')) return true
  return false
}

/**
 * Empty/critical vetoes fail.
 * - Non-empty veto list fails (feed already flagged the row).
 * - Non-array veto payload fails.
 * - Missing field is "not present" (runs/revivals) and does not fail.
 * - Empty array passes.
 */
export function vetoesFail(vetoes: unknown): boolean {
  if (vetoes == null) return false
  if (!Array.isArray(vetoes)) return true
  if (vetoes.length === 0) return false
  return vetoes.some((v) => {
    if (typeof v !== 'string') return true
    const t = v.trim()
    if (!t) return true
    return true
  })
}

/** Liq floor applies only when `liq` is present. */
export function liqBelowFloor(liq: unknown, floor = LIQ_FLOOR_USD): boolean {
  const n = asFiniteNumber(liq)
  if (n == null) return false
  return n < floor
}

export function isRingHeuristic(row: ScoutFeedRow): boolean {
  const bundle = asObject(row.evmBundle)
  if (!bundle) return false
  return normText(bundle.verdict) === 'ring'
}

function freshRatio(fresh: unknown, total: unknown): number | null {
  const f = asFiniteNumber(fresh)
  const n = asFiniteNumber(total)
  if (f == null || n == null || n <= 0) return null
  return f / n
}

export function isFreshHeuristic(row: ScoutFeedRow): boolean {
  const warn = asObject(row.rhFreshWarn)
  if (warn) {
    const ratio = freshRatio(warn.fresh, warn.of)
    if (ratio != null && ratio >= FRESH_RATIO) return true
  }
  const bundle = asObject(row.evmBundle)
  if (bundle) {
    const ratio = freshRatio(bundle.fresh, bundle.n)
    if (ratio != null && ratio >= FRESH_RATIO) return true
  }
  return false
}

export function isCopycatHeuristic(row: ScoutFeedRow): boolean {
  const nameReuse = asFiniteNumber(row.nameReuse)
  if (nameReuse != null && nameReuse >= COPYCAT_NAME_REUSE) return true
  const imageReuse = asFiniteNumber(row.imageReuse)
  if (imageReuse != null && imageReuse >= COPYCAT_IMAGE_REUSE) return true
  const registry = asObject(row.registryReuse)
  if (registry) {
    const namePrior = asFiniteNumber(registry.namePrior)
    const comboPrior = asFiniteNumber(registry.comboPrior)
    if (namePrior != null && namePrior >= COPYCAT_REGISTRY_NAME_PRIOR) return true
    if (comboPrior != null && comboPrior >= COPYCAT_REGISTRY_COMBO_PRIOR) return true
  }
  return false
}

export function toScoutCandidate(row: ScoutFeedRow, chain: ScoutChain, mint: string): ScoutCandidate {
  const symbol = typeof row.symbol === 'string' && row.symbol.trim() ? row.symbol.trim() : mint.slice(0, 6)
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : symbol
  const id =
    row.id != null
      ? String(row.id)
      : mintKey(chain, mint)
  return {
    id,
    ts: asFiniteNumber(row.ts),
    kind: typeof row.kind === 'string' ? row.kind : 'vetted',
    chain,
    mint,
    symbol,
    name,
    image: typeof row.image === 'string' && row.image.trim() ? row.image : null,
    url: typeof row.url === 'string' && row.url.trim() ? row.url : null,
    decision: typeof row.decision === 'string' ? row.decision : row.decision === null ? null : null,
    score: asFiniteNumber(row.score),
    mcap: asFiniteNumber(row.mcap),
    liq: asFiniteNumber(row.liq),
    ageMin: asFiniteNumber(row.ageMin),
    source: typeof row.source === 'string' ? row.source : null,
    vetoes: Array.isArray(row.vetoes)
      ? row.vetoes.filter((v): v is string => typeof v === 'string')
      : [],
    sightings: asObject(row.sightings) as ScoutSightings | null,
  }
}

export function evaluateScoutRow(row: ScoutFeedRow): FilterOutcome {
  const mint = typeof row.mint === 'string' ? row.mint.trim() : ''
  if (!mint) return { ok: false, reason: 'missing_mint' }
  const chain = normalizeScoutChain(row.chain)
  if (!chain) return { ok: false, reason: 'missing_chain' }
  if (!isPreferredCandidate(row)) return { ok: false, reason: 'decision' }
  if (vetoesFail(row.vetoes)) return { ok: false, reason: 'veto' }
  if (liqBelowFloor(row.liq)) return { ok: false, reason: 'liq' }
  if (isRingHeuristic(row)) return { ok: false, reason: 'ring' }
  if (isFreshHeuristic(row)) return { ok: false, reason: 'fresh' }
  if (isCopycatHeuristic(row)) return { ok: false, reason: 'copycat' }
  return { ok: true, candidate: toScoutCandidate(row, chain, mint) }
}

export function filterScoutRows(
  rows: ScoutFeedRow[],
  chain: ScoutChainQuery = 'all',
): { candidates: ScoutCandidate[]; rejected: Record<ScoutRejectReason, number> } {
  const rejected = Object.fromEntries(
    SCOUT_REJECT_REASONS.map((r) => [r, 0]),
  ) as Record<ScoutRejectReason, number>
  const seen = new Set<string>()
  const candidates: ScoutCandidate[] = []

  for (const row of rows) {
    const outcome = evaluateScoutRow(row)
    if (!outcome.ok) {
      rejected[outcome.reason] += 1
      continue
    }
    if (chain !== 'all' && outcome.candidate.chain !== chain) continue
    const key = mintKey(outcome.candidate.chain, outcome.candidate.mint)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(outcome.candidate)
  }

  candidates.sort((a, b) => {
    const scoreA = a.score ?? -1
    const scoreB = b.score ?? -1
    if (scoreB !== scoreA) return scoreB - scoreA
    return (b.ts ?? 0) - (a.ts ?? 0)
  })

  return { candidates, rejected }
}

export function parseDataPublicFeed(body: unknown): {
  rows: ScoutFeedRow[]
  meta: ScoutFeedMeta
} {
  const o = asObject(body)
  const rowsRaw = Array.isArray(o?.rows) ? o.rows : []
  const rows: ScoutFeedRow[] = []
  for (const item of rowsRaw) {
    const row = asObject(item)
    if (row) rows.push(row as ScoutFeedRow)
  }
  const counts = asObject(o?.counts)
  return {
    rows,
    meta: {
      generatedAt: asFiniteNumber(o?.generatedAt),
      solDelayMin: asFiniteNumber(o?.solDelayMin) ?? 15,
      windowH: asFiniteNumber(o?.windowH),
      page: asFiniteNumber(o?.page),
      pages: asFiniteNumber(o?.pages),
      upstreamCounts: counts
        ? Object.fromEntries(
            Object.entries(counts).flatMap(([k, v]) => {
              const n = asFiniteNumber(v)
              return n == null ? [] : [[k, n]]
            }),
          )
        : null,
    },
  }
}

/**
 * Paper-sim from this feed only when the binary climate *display* label is Safe.
 * Header chip stays display-only for live trade controls.
 */
export function canPaperNotchFromClimate(
  label: ClimateChipLabel | string | null | undefined,
): boolean {
  return label === 'Safe'
}

export function paperNotchDisabledTip(label: ClimateChipLabel | string | null | undefined): string {
  if (label === 'Safe') return ''
  if (label === 'Not safe') {
    return 'Paper note disabled while climate is Not safe. Observe only — no new paper notches from this feed.'
  }
  return 'Paper note disabled while climate is Unknown. Observe only — no new paper notches from this feed.'
}

export type ScoutBffResponse = {
  ok: true
  strategyId: typeof BUYBULK_DATAPUBLIC_SCOUT_ID
  chain: ScoutChainQuery
  generatedAt: number | null
  solDelayMin: number
  windowH: number | null
  climateAtEmit: ClimateChipPayload
  paperAllowed: boolean
  counts: {
    upstream: number
    candidates: number
    rh: number
    sol: number
    rejected: Record<ScoutRejectReason, number>
  }
  rows: ScoutCandidate[]
  disclaimer: string
}

export function buildScoutBffResponse(opts: {
  chain: ScoutChainQuery
  rows: ScoutFeedRow[]
  meta: ScoutFeedMeta
  climateAtEmit: ClimateChipPayload
}): ScoutBffResponse {
  const { candidates, rejected } = filterScoutRows(opts.rows, opts.chain)
  return {
    ok: true,
    strategyId: BUYBULK_DATAPUBLIC_SCOUT_ID,
    chain: opts.chain,
    generatedAt: opts.meta.generatedAt,
    solDelayMin: opts.meta.solDelayMin,
    windowH: opts.meta.windowH,
    climateAtEmit: opts.climateAtEmit,
    paperAllowed: canPaperNotchFromClimate(opts.climateAtEmit.label),
    counts: {
      upstream: opts.rows.length,
      candidates: candidates.length,
      rh: candidates.filter((r) => r.chain === 'robinhood').length,
      sol: candidates.filter((r) => r.chain === 'solana').length,
      rejected,
    },
    rows: candidates,
    disclaimer: DATA_PUBLIC_STUDY_DISCLAIMER,
  }
}

export function dataPublicFeedUrl(): string {
  const raw = process.env.DATA_PUBLIC_FEED_URL?.trim()
  return raw || DATA_PUBLIC_FEED_DEFAULT
}
