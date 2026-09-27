/**
 * Shadow-only TypeSafe Jev Noul gate beside the social FOMO burst paper open.
 *
 * Shadow by default: it records what Jev would have decided and never changes
 * the open until SOCIAL_FOMO_NOUL_MODE=enforce. Missing creds / timeout / http /
 * parse → fall back to the code path (the burst gate); Noul has no confidence
 * field, so a mid band follows the code path too.
 *
 * SPEC: docs/specs/SPEC-jev-soft-gate-shadow-v1.md (same pattern, social arm).
 */

import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import {
  callTypeSafeNoulQuestion,
  type TypeSafeNoulCallResult,
} from '@/strategies/typesafe-noul'

export const SOCIAL_FOMO_NOUL_QUESTION_KEY = 'social_fomo_open'
export const SOCIAL_FOMO_NOUL_INSTRUCTIONS =
  'Should we paper-open this FOMO mention burst to ride a possible moonbag? Answer yes to open, no to skip.'

export const DEFAULT_SOCIAL_FOMO_NOUL_NO = 0.4
export const DEFAULT_SOCIAL_FOMO_NOUL_YES = 0.7

export type SocialFomoNoulBand = 'suppress' | 'mid' | 'keep' | 'api_miss'
export type SocialFomoNoulDecision = 'keep' | 'suppress' | 'follow_spec'
export type SocialFomoNoulMode = 'shadow' | 'enforce'

function parseOnOff(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === '') return fallback
  const v = raw.trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(v)) return true
  if (['0', 'false', 'off', 'no'].includes(v)) return false
  return fallback
}

function parseFinite(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Shadow rows + Noul calls. Default ON. */
export function socialFomoNoulShadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseOnOff(env.SOCIAL_FOMO_NOUL_SHADOW, true)
}

/** Kill switch forces shadow-only (no behavior change). */
export function socialFomoNoulMode(env: Record<string, string | undefined> = process.env): SocialFomoNoulMode {
  if (parseOnOff(env.SOCIAL_FOMO_NOUL_KILL_SWITCH, false)) return 'shadow'
  return env.SOCIAL_FOMO_NOUL_MODE?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'shadow'
}

export function getSocialFomoNoulNo(env: Record<string, string | undefined> = process.env): number {
  return parseFinite(env.SOCIAL_FOMO_NOUL_NO, DEFAULT_SOCIAL_FOMO_NOUL_NO)
}

export function getSocialFomoNoulYes(env: Record<string, string | undefined> = process.env): number {
  return parseFinite(env.SOCIAL_FOMO_NOUL_YES, DEFAULT_SOCIAL_FOMO_NOUL_YES)
}

export function classifySocialFomoNoulBand(
  noul: number | null,
  opts: { no?: number; yes?: number } = {},
): SocialFomoNoulBand {
  if (noul == null || !Number.isFinite(noul)) return 'api_miss'
  const no = opts.no ?? DEFAULT_SOCIAL_FOMO_NOUL_NO
  const yes = opts.yes ?? DEFAULT_SOCIAL_FOMO_NOUL_YES
  if (noul <= no) return 'suppress'
  if (noul >= yes) return 'keep'
  return 'mid'
}

/** mid + api_miss → follow_spec, i.e. the code path (burst gate) decides. */
export function decisionFromBand(band: SocialFomoNoulBand): SocialFomoNoulDecision {
  if (band === 'keep') return 'keep'
  if (band === 'suppress') return 'suppress'
  return 'follow_spec'
}

export type SocialFomoNoulStateInput = {
  chain: string
  mentions30m: number
  mentions24h: number
  uniqueChannels30m: number
  minutesSinceFirstMention: number | null
  fomoBuyCount1h: number
  fomoEdge1h: number | null
  mcap: number | null
  firstMcap: number | null
  mcapGrowthPct: number | null
  holdersPct: number | null
  organicScore: number | null
}

/** No secrets in state. */
export function buildSocialFomoNoulState(
  input: SocialFomoNoulStateInput,
): Record<string, unknown> {
  return {
    chain: input.chain,
    mentions_30m: input.mentions30m,
    mentions_24h: input.mentions24h,
    unique_channels_30m: input.uniqueChannels30m,
    minutes_since_first_mention: input.minutesSinceFirstMention,
    fomo_buy_count_1h: input.fomoBuyCount1h,
    fomo_edge_1h: input.fomoEdge1h,
    mcap: input.mcap,
    first_mcap: input.firstMcap,
    mcap_growth_pct: input.mcapGrowthPct,
    top_holders_pct: input.holdersPct,
    organic_score: input.organicScore,
  }
}

export type SocialFomoNoulVerdict = {
  called: boolean
  noul: number | null
  band: SocialFomoNoulBand
  decision: SocialFomoNoulDecision
  mode: SocialFomoNoulMode
}

export function socialFomoNoulSuppresses(verdict: SocialFomoNoulVerdict): boolean {
  return verdict.mode === 'enforce' && verdict.decision === 'suppress'
}

export async function evaluateSocialFomoNoul(
  state: SocialFomoNoulStateInput,
  deps?: {
    env?: Record<string, string | undefined>
    call?: typeof callTypeSafeNoulQuestion
    apiKey?: string | null
    fetchImpl?: typeof fetch
  },
): Promise<SocialFomoNoulVerdict> {
  const env = deps?.env ?? process.env
  const mode = socialFomoNoulMode(env)
  if (!socialFomoNoulShadowEnabled(env)) {
    return { called: false, noul: null, band: 'api_miss', decision: 'follow_spec', mode }
  }

  const call = deps?.call ?? callTypeSafeNoulQuestion
  let result: TypeSafeNoulCallResult
  try {
    result = await call(
      buildSocialFomoNoulState(state),
      {
        questionKey: SOCIAL_FOMO_NOUL_QUESTION_KEY,
        instructions: SOCIAL_FOMO_NOUL_INSTRUCTIONS,
        criteria: { true: 'Open the paper position', false: 'Skip the paper position' },
      },
      { apiKey: deps?.apiKey, fetchImpl: deps?.fetchImpl },
    )
  } catch {
    result = { ok: false, reason: 'exception' }
  }

  const noul = result.ok ? result.noul : null
  const band = result.ok
    ? classifySocialFomoNoulBand(noul, {
        no: getSocialFomoNoulNo(env),
        yes: getSocialFomoNoulYes(env),
      })
    : 'api_miss'
  return { called: true, noul, band, decision: decisionFromBand(band), mode }
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS social_fomo_noul_shadow (
    id BIGSERIAL PRIMARY KEY,
    predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    token_address TEXT NOT NULL,
    symbol TEXT,
    chain TEXT NOT NULL DEFAULT 'sol',
    strategy_key TEXT NOT NULL,
    mentions_30m INTEGER NOT NULL,
    mentions_24h INTEGER NOT NULL DEFAULT 0,
    unique_channels_30m INTEGER NOT NULL DEFAULT 0,
    fomo_buy_count_1h INTEGER NOT NULL DEFAULT 0,
    fomo_edge_1h DOUBLE PRECISION,
    mcap DOUBLE PRECISION,
    mcap_growth_pct DOUBLE PRECISION,
    holders_pct DOUBLE PRECISION,
    organic_score DOUBLE PRECISION,
    spec_would_pass BOOLEAN NOT NULL,
    noul_called BOOLEAN NOT NULL DEFAULT FALSE,
    noul DOUBLE PRECISION,
    band TEXT NOT NULL CHECK (band IN ('suppress', 'mid', 'keep', 'api_miss')),
    decision_shadow TEXT NOT NULL CHECK (decision_shadow IN ('keep', 'suppress', 'follow_spec')),
    mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce'))
  )
`

let ensurePromise: Promise<void> | null = null

async function ensureSocialFomoNoulShadowTable(): Promise<void> {
  if (ensurePromise) {
    await ensurePromise
    return
  }
  ensurePromise = (async () => {
    await query(CREATE_TABLE_SQL)
    await query(`
      CREATE INDEX IF NOT EXISTS social_fomo_noul_shadow_predicted_at_idx
      ON social_fomo_noul_shadow (predicted_at DESC)
    `)
    await query(`
      CREATE INDEX IF NOT EXISTS social_fomo_noul_shadow_strategy_predicted_idx
      ON social_fomo_noul_shadow (strategy_key, predicted_at DESC)
    `)
  })()
    .then(() => undefined)
    .catch((err) => {
      ensurePromise = null
      throw err
    })
  await ensurePromise
}

export type SocialFomoNoulShadowRow = {
  tokenAddress: string
  symbol?: string | null
  chain: string
  strategyKey: string
  mentions30m: number
  mentions24h: number
  uniqueChannels30m: number
  fomoBuyCount1h: number
  fomoEdge1h: number | null
  mcap: number | null
  mcapGrowthPct: number | null
  holdersPct: number | null
  organicScore: number | null
  specWouldPass: boolean
  noulCalled: boolean
  noul: number | null
  band: SocialFomoNoulBand
  decisionShadow: SocialFomoNoulDecision
  mode: SocialFomoNoulMode
}

/** Fail-soft: the shadow sink must never break an open. */
export async function recordSocialFomoNoulShadowRow(
  row: SocialFomoNoulShadowRow,
): Promise<void> {
  try {
    await ensureSocialFomoNoulShadowTable()
    await query(
      `INSERT INTO social_fomo_noul_shadow (
         token_address, symbol, chain, strategy_key,
         mentions_30m, mentions_24h, unique_channels_30m,
         fomo_buy_count_1h, fomo_edge_1h, mcap, mcap_growth_pct,
         holders_pct, organic_score, spec_would_pass,
         noul_called, noul, band, decision_shadow, mode
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        row.tokenAddress,
        row.symbol ?? null,
        row.chain,
        row.strategyKey,
        row.mentions30m,
        row.mentions24h,
        row.uniqueChannels30m,
        row.fomoBuyCount1h,
        row.fomoEdge1h,
        row.mcap,
        row.mcapGrowthPct,
        row.holdersPct,
        row.organicScore,
        row.specWouldPass,
        row.noulCalled,
        row.noul,
        row.band,
        row.decisionShadow,
        row.mode,
      ],
    )
  } catch (error) {
    if (isMissingSchemaError(error)) return
    console.error('[social-fomo-noul-shadow] insert failed:', error)
  }
}
