/**
 * Shadow-only TypeSafe Jev gate beside the social FOMO burst paper open.
 *
 * Two atomic propositions (docs.typesafe.ai: one narrow judgment per question),
 * combined by thresholds in this code — not by the model:
 *   - `social_fomo_organic`    — is the mention burst an organic surge, not a raid?
 *   - `social_fomo_candles_ok` — are the recent 1m candles not a rekt shape?
 *
 * Shadow by default: it records what Jev would have decided and never changes
 * the open until SOCIAL_FOMO_NOUL_MODE=enforce. Missing creds / timeout / http /
 * parse → fall back to the code path (the burst gate); Noul has no confidence
 * field, so a mid band follows the code path too. No candle data → the candle arm
 * follows the code path rather than inventing a verdict.
 *
 * SPEC: docs/specs/SPEC-jev-soft-gate-shadow-v1.md (same pattern, social arm).
 */

import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import {
  callTypeSafeNoulQuestions,
  type TypeSafeNoulMultiResult,
} from '@/strategies/typesafe-noul'

export const SOCIAL_FOMO_ORGANIC_QUESTION_KEY = 'social_fomo_organic'
export const SOCIAL_FOMO_CANDLES_QUESTION_KEY = 'social_fomo_candles_ok'

export const SOCIAL_FOMO_ORGANIC_INSTRUCTIONS =
  '`state.mentions_30m` mentions are an organic, multi-channel surge among independent accounts, not a single-source spam or bot raid. Weigh `state.unique_channels_30m`, `state.telegram_top_source`, `state.fomo_buy_count_1h` and `state.fomo_edge_1h`.'

export const SOCIAL_FOMO_CANDLES_INSTRUCTIONS =
  'The recent `state.ohlc_n` one-minute candles are not a rekt shape: no ≥40% dump across the window, no sustained upper-wick rejection, and not a straight all-green climax. Weigh `state.ohlc_dump_pct`, `state.ohlc_avg_upper_wick`, `state.ohlc_up_only_count` and `state.ohlc_rug_trip`.'

export const DEFAULT_SOCIAL_FOMO_NOUL_NO = 0.4
export const DEFAULT_SOCIAL_FOMO_NOUL_YES = 0.7

export type SocialFomoNoulBand = 'suppress' | 'mid' | 'keep' | 'api_miss'
export type SocialFomoNoulDecision = 'keep' | 'suppress' | 'follow_spec'
export type SocialFomoNoulMode = 'shadow' | 'enforce'
/** Per-question outcome. `follow` = not decisive; the code path decides. */
export type SocialFomoNoulArm = 'keep' | 'suppress' | 'follow'

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

/** Shadow rows + Jev calls. Default ON. */
export function socialFomoNoulShadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseOnOff(env.SOCIAL_FOMO_NOUL_SHADOW, true)
}

/** Kill switch forces shadow-only (no behavior change). */
export function socialFomoNoulMode(env: Record<string, string | undefined> = process.env): SocialFomoNoulMode {
  if (parseOnOff(env.SOCIAL_FOMO_NOUL_KILL_SWITCH, false)) return 'shadow'
  return env.SOCIAL_FOMO_NOUL_MODE?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'shadow'
}

export function getSocialFomoNoulOrganicNo(env: Record<string, string | undefined> = process.env): number {
  return parseFinite(env.SOCIAL_FOMO_NOUL_ORGANIC_NO, DEFAULT_SOCIAL_FOMO_NOUL_NO)
}

export function getSocialFomoNoulOrganicYes(env: Record<string, string | undefined> = process.env): number {
  return parseFinite(env.SOCIAL_FOMO_NOUL_ORGANIC_YES, DEFAULT_SOCIAL_FOMO_NOUL_YES)
}

export function getSocialFomoNoulCandlesNo(env: Record<string, string | undefined> = process.env): number {
  return parseFinite(env.SOCIAL_FOMO_NOUL_CANDLES_NO, DEFAULT_SOCIAL_FOMO_NOUL_NO)
}

export function getSocialFomoNoulCandlesYes(env: Record<string, string | undefined> = process.env): number {
  return parseFinite(env.SOCIAL_FOMO_NOUL_CANDLES_YES, DEFAULT_SOCIAL_FOMO_NOUL_YES)
}

/** Legacy single-band accessors — the organic arm's thresholds. */
export function getSocialFomoNoulNo(env: Record<string, string | undefined> = process.env): number {
  return getSocialFomoNoulOrganicNo(env)
}

export function getSocialFomoNoulYes(env: Record<string, string | undefined> = process.env): number {
  return getSocialFomoNoulOrganicYes(env)
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

function armFromBand(band: SocialFomoNoulBand): SocialFomoNoulArm {
  if (band === 'keep') return 'keep'
  if (band === 'suppress') return 'suppress'
  return 'follow'
}

/**
 * Combine the two arms in code. `keep` needs BOTH to be confident; either
 * `suppress` wins; anything undecided (mid, missed, no candle data) falls to the
 * code path. Never invents a verdict from an absent arm.
 */
export function combineSocialFomoNoulBands(
  organicBand: SocialFomoNoulBand,
  candlesBand: SocialFomoNoulBand,
  candlesUsable: boolean,
): SocialFomoNoulBand {
  const organic = armFromBand(organicBand)
  const candles = candlesUsable ? armFromBand(candlesBand) : 'follow'
  if (organic === 'suppress' || candles === 'suppress') return 'suppress'
  if (organic === 'keep' && candles === 'keep') return 'keep'
  return 'mid'
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
  /** OHLC rug snapshot — absent when no bars (arm follows the code path). */
  ohlcN?: number | null
  ohlcSource?: string | null
  ohlcDumpPct?: number | null
  ohlcAvgUpperWick?: number | null
  ohlcUpOnlyCount?: number | null
  ohlcVolDeathRatio?: number | null
  ohlcRugTrip?: boolean | null
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
    ohlc_n: input.ohlcN ?? null,
    ohlc_source: input.ohlcSource ?? null,
    ohlc_dump_pct: input.ohlcDumpPct ?? null,
    ohlc_avg_upper_wick: input.ohlcAvgUpperWick ?? null,
    ohlc_up_only_count: input.ohlcUpOnlyCount ?? null,
    ohlc_vol_death_ratio: input.ohlcVolDeathRatio ?? null,
    ohlc_rug_trip: input.ohlcRugTrip ?? null,
  }
}

export type SocialFomoNoulVerdict = {
  called: boolean
  /** Min of the usable answers (dashboards); null when nothing came back. */
  noul: number | null
  organic: number | null
  candles: number | null
  organicBand: SocialFomoNoulBand
  candlesBand: SocialFomoNoulBand
  band: SocialFomoNoulBand
  decision: SocialFomoNoulDecision
  mode: SocialFomoNoulMode
}

export function socialFomoNoulSuppresses(verdict: SocialFomoNoulVerdict): boolean {
  return verdict.mode === 'enforce' && verdict.decision === 'suppress'
}

function minDefined(values: Array<number | null>): number | null {
  let min: number | null = null
  for (const v of values) {
    if (v == null) continue
    if (min == null || v < min) min = v
  }
  return min
}

export async function evaluateSocialFomoNoul(
  state: SocialFomoNoulStateInput,
  deps?: {
    env?: Record<string, string | undefined>
    call?: typeof callTypeSafeNoulQuestions
    apiKey?: string | null
    fetchImpl?: typeof fetch
  },
): Promise<SocialFomoNoulVerdict> {
  const env = deps?.env ?? process.env
  const mode = socialFomoNoulMode(env)
  const idle: SocialFomoNoulVerdict = {
    called: false,
    noul: null,
    organic: null,
    candles: null,
    organicBand: 'api_miss',
    candlesBand: 'api_miss',
    band: 'api_miss',
    decision: 'follow_spec',
    mode,
  }
  if (!socialFomoNoulShadowEnabled(env)) {
    return idle
  }

  const candlesUsable = (state.ohlcN ?? 0) > 0
  const questions = [
    {
      questionKey: SOCIAL_FOMO_ORGANIC_QUESTION_KEY,
      instructions: SOCIAL_FOMO_ORGANIC_INSTRUCTIONS,
      criteria: {
        true: 'Mentions come from multiple independent channels/accounts at a normal, non-spam cadence.',
        false: 'Mentions look like one source, copy-paste spam, or a coordinated bot raid.',
      },
    },
  ]
  if (candlesUsable) {
    questions.push({
      questionKey: SOCIAL_FOMO_CANDLES_QUESTION_KEY,
      instructions: SOCIAL_FOMO_CANDLES_INSTRUCTIONS,
      criteria: {
        true: 'Candles form a healthy base or orderly move — no crash, no sustained upper-wick rejection, not all-green.',
        false: 'Candles are rekt — a ≥40% dump over the window, sustained upper wicks, or an all-green blow-off.',
      },
    })
  }

  const call = deps?.call ?? callTypeSafeNoulQuestions
  let result: TypeSafeNoulMultiResult
  try {
    result = await call(buildSocialFomoNoulState(state), questions, {
      apiKey: deps?.apiKey,
      fetchImpl: deps?.fetchImpl,
    })
  } catch {
    result = { ok: false, reason: 'exception' }
  }

  if (!result.ok) {
    return { ...idle, called: true }
  }

  const organic = result.answers[SOCIAL_FOMO_ORGANIC_QUESTION_KEY] ?? null
  const candles = candlesUsable
    ? result.answers[SOCIAL_FOMO_CANDLES_QUESTION_KEY] ?? null
    : null
  const organicBand = classifySocialFomoNoulBand(organic, {
    no: getSocialFomoNoulOrganicNo(env),
    yes: getSocialFomoNoulOrganicYes(env),
  })
  const candlesBand = candlesUsable
    ? classifySocialFomoNoulBand(candles, {
        no: getSocialFomoNoulCandlesNo(env),
        yes: getSocialFomoNoulCandlesYes(env),
      })
    : 'api_miss'
  const band = combineSocialFomoNoulBands(organicBand, candlesBand, candlesUsable)

  return {
    called: true,
    noul: minDefined([organic, candles]),
    organic,
    candles,
    organicBand,
    candlesBand,
    band,
    decision: decisionFromBand(band),
    mode,
  }
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
    mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce')),
    organic_noul DOUBLE PRECISION,
    candles_noul DOUBLE PRECISION,
    answers JSONB,
    ohlc_n INTEGER,
    ohlc_source TEXT
  );
  ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS organic_noul DOUBLE PRECISION;
  ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS candles_noul DOUBLE PRECISION;
  ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS answers JSONB;
  ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS ohlc_n INTEGER;
  ALTER TABLE social_fomo_noul_shadow ADD COLUMN IF NOT EXISTS ohlc_source TEXT;
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
  organicNoul?: number | null
  candlesNoul?: number | null
  organicBand?: SocialFomoNoulBand
  candlesBand?: SocialFomoNoulBand
  ohlcN?: number | null
  ohlcSource?: string | null
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
         noul_called, noul, band, decision_shadow, mode,
         organic_noul, candles_noul, answers, ohlc_n, ohlc_source
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24)`,
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
        row.organicNoul ?? null,
        row.candlesNoul ?? null,
        JSON.stringify({
          organic: row.organicNoul ?? null,
          candles: row.candlesNoul ?? null,
          organic_band: row.organicBand ?? null,
          candles_band: row.candlesBand ?? null,
        }),
        row.ohlcN ?? null,
        row.ohlcSource ?? null,
      ],
    )
  } catch (error) {
    if (isMissingSchemaError(error)) return
    console.error('[social-fomo-noul-shadow] insert failed:', error)
  }
}
