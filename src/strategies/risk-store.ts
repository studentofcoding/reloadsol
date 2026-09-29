/**
 * Shadow risk store: persists RugCheck features + dev reputation and composes the
 * display label. All writes are best-effort — a DB/upstream error never blocks a tick.
 *
 * Tables live in db/init/48-dev-reputation-and-risk.sql; the ensure here mirrors
 * detect-snapshots so dev environments work without the migration applied.
 */

import { query, queryOne } from '@/utils/db'
import { getRugcheckFeaturesCached, isRugcheckEnabled } from '@/utils/rugcheck-api'
import type { RugcheckFeatures } from '@/strategies/rugcheck-features'
import {
  devReputationMode,
  fetchDevReputation,
  isDevReputationEnabled,
  resolveCreatorAddress,
} from '@/utils/dev-reputation-data'
import type {
  DevReputation,
  DevTokenRef,
  DevVerdict,
} from '@/strategies/dev-reputation'
import {
  composeRiskLabel,
  type RiskChipTone,
  type RiskLabel,
} from '@/strategies/risk-label'

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS token_risk_features (
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  creator_address TEXT,
  rugcheck_score REAL,
  rugcheck_score_norm REAL,
  rugcheck_risk_names TEXT[] NOT NULL DEFAULT '{}',
  rugcheck_risk_points INTEGER,
  rugcheck_insiders INTEGER,
  rugcheck_lp_locked_pct REAL,
  rugcheck_locker_status TEXT,
  rugcheck_mutable_meta BOOLEAN,
  rugcheck_rugged BOOLEAN,
  creator_balance NUMERIC,
  dev_verdict TEXT NOT NULL DEFAULT 'unknown'
    CHECK (dev_verdict IN ('ban', 'good', 'inconclusive', 'unknown')),
  dev_sample INTEGER,
  dev_graduation_ratio REAL,
  dev_ath_mc NUMERIC,
  dev_reasons TEXT[] NOT NULL DEFAULT '{}',
  risk_label TEXT,
  risk_reasons TEXT[] NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce')),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, token_address)
);
CREATE TABLE IF NOT EXISTS dev_reputation (
  chain TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  sample INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  inner_count INTEGER NOT NULL DEFAULT 0,
  graduation_ratio REAL,
  ath_mc NUMERIC,
  verdict TEXT NOT NULL DEFAULT 'unknown'
    CHECK (verdict IN ('ban', 'good', 'inconclusive', 'unknown')),
  reasons TEXT[] NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce')),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  re_eval_after TIMESTAMPTZ,
  PRIMARY KEY (chain, creator_address)
);
ALTER TABLE dev_reputation
  ADD COLUMN IF NOT EXISTS tokens JSONB NOT NULL DEFAULT '[]'::jsonb;
`

let ensurePromise: Promise<void> | null = null

/** Idempotent table ensure (mirrors detect-snapshots). */
export async function ensureRiskTables(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = query(ENSURE_SQL)
      .then(() => undefined)
      .catch((err) => {
        ensurePromise = null
        throw err
      })
  }
  await ensurePromise
}

export type RiskShadowResult = {
  label: RiskLabel | null
  rugcheck: RugcheckFeatures | null
  dev: DevReputation | null
  creator: string | null
  mode: 'shadow' | 'enforce'
}

function persist(input: {
  chain: string
  tokenAddress: string
  creator: string | null
  rugcheck: RugcheckFeatures | null
  dev: DevReputation | null
  label: RiskLabel
  mode: 'shadow' | 'enforce'
}): Promise<unknown> {
  const { rugcheck, dev, label, mode } = input
  return query(
    `INSERT INTO token_risk_features (
       chain, token_address, creator_address,
       rugcheck_score, rugcheck_score_norm, rugcheck_risk_names, rugcheck_risk_points,
       rugcheck_insiders, rugcheck_lp_locked_pct, rugcheck_locker_status,
       rugcheck_mutable_meta, rugcheck_rugged, creator_balance,
       dev_verdict, dev_sample, dev_graduation_ratio, dev_ath_mc, dev_reasons,
       risk_label, risk_reasons, mode, evaluated_at, updated_at
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6::text[], $7,
       $8, $9, $10,
       $11, $12, $13,
       $14, $15, $16, $17, $18::text[],
       $19, $20::text[], $21, NOW(), NOW()
     )
     ON CONFLICT (chain, token_address) DO UPDATE SET
       creator_address = EXCLUDED.creator_address,
       rugcheck_score = EXCLUDED.rugcheck_score,
       rugcheck_score_norm = EXCLUDED.rugcheck_score_norm,
       rugcheck_risk_names = EXCLUDED.rugcheck_risk_names,
       rugcheck_risk_points = EXCLUDED.rugcheck_risk_points,
       rugcheck_insiders = EXCLUDED.rugcheck_insiders,
       rugcheck_lp_locked_pct = EXCLUDED.rugcheck_lp_locked_pct,
       rugcheck_locker_status = EXCLUDED.rugcheck_locker_status,
       rugcheck_mutable_meta = EXCLUDED.rugcheck_mutable_meta,
       rugcheck_rugged = EXCLUDED.rugcheck_rugged,
       creator_balance = EXCLUDED.creator_balance,
       dev_verdict = EXCLUDED.dev_verdict,
       dev_sample = EXCLUDED.dev_sample,
       dev_graduation_ratio = EXCLUDED.dev_graduation_ratio,
       dev_ath_mc = EXCLUDED.dev_ath_mc,
       dev_reasons = EXCLUDED.dev_reasons,
       risk_label = EXCLUDED.risk_label,
       risk_reasons = EXCLUDED.risk_reasons,
       mode = EXCLUDED.mode,
       updated_at = NOW()`,
    [
      input.chain,
      input.tokenAddress,
      input.creator,
      rugcheck?.score ?? null,
      rugcheck?.scoreNormalised ?? null,
      rugcheck?.riskNames ?? [],
      rugcheck?.riskPoints ?? null,
      rugcheck?.graphInsidersDetected ?? null,
      rugcheck?.lpLockedPct ?? null,
      rugcheck?.lockerScanStatus ?? null,
      rugcheck?.mutableMetadata ?? null,
      rugcheck?.rugged ?? null,
      rugcheck?.creatorBalance ?? null,
      dev?.verdict ?? 'unknown',
      dev?.sample ?? null,
      dev?.graduationRatio ?? null,
      dev?.athMc ?? null,
      dev?.reasons ?? [],
      label.rugcheck ?? label.devRep ?? null,
      label.reasons,
      mode,
    ],
  )
}

async function persistDevReputation(input: {
  chain: string
  creator: string
  dev: DevReputation
  mode: 'shadow' | 'enforce'
}): Promise<unknown> {
  const ttlHours = Number(process.env.DEV_REPUTATION_TTL_S)
  const hours = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours / 3600 : 24
  return query(
    `INSERT INTO dev_reputation (
       chain, creator_address, sample, open_count, inner_count,
       graduation_ratio, ath_mc, verdict, reasons, mode,
       tokens, evaluated_at, re_eval_after
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10,
       $11::jsonb, NOW(), NOW() + ($12 || ' hours')::interval)
     ON CONFLICT (chain, creator_address) DO UPDATE SET
       sample = EXCLUDED.sample,
       open_count = EXCLUDED.open_count,
       inner_count = EXCLUDED.inner_count,
       graduation_ratio = EXCLUDED.graduation_ratio,
       ath_mc = EXCLUDED.ath_mc,
       verdict = EXCLUDED.verdict,
       reasons = EXCLUDED.reasons,
       mode = EXCLUDED.mode,
       tokens = EXCLUDED.tokens,
       evaluated_at = NOW(),
       re_eval_after = EXCLUDED.re_eval_after`,
    [
      input.chain,
      input.creator,
      input.dev.sample,
      input.dev.openCount,
      input.dev.innerCount,
      input.dev.graduationRatio,
      input.dev.athMc,
      input.dev.verdict,
      input.dev.reasons,
      input.mode,
      JSON.stringify(input.dev.tokens ?? []),
      String(hours),
    ],
  )
}

/**
 * Compute + persist the shadow risk label for one token. Never throws.
 * Returns an empty result when both flags are off.
 */
export async function attachRiskShadow(params: {
  chain: string
  tokenAddress: string
  info: Record<string, unknown>
}): Promise<RiskShadowResult> {
  const mode = devReputationMode()
  const rugcheckOn = params.chain === 'sol' && isRugcheckEnabled()
  const devOn = isDevReputationEnabled()

  if (!rugcheckOn && !devOn) {
    return { label: null, rugcheck: null, dev: null, creator: null, mode }
  }

  let rugcheck: RugcheckFeatures | null = null
  if (rugcheckOn) {
    rugcheck = await getRugcheckFeaturesCached(params.tokenAddress).catch(() => null)
  }

  let creator: string | null = null
  let dev: DevReputation | null = null
  if (devOn) {
    creator = await resolveCreatorAddress({
      chain: params.chain,
      info: params.info,
      mint: params.tokenAddress,
    }).catch(() => null)
    if (creator) {
      dev = await fetchDevReputation({ chain: params.chain, creator }).catch(
        () => null,
      )
    }
  }

  const label = composeRiskLabel({ rugcheck, dev, shadow: mode === 'shadow' })

  // Nothing to store when both upstreams were unavailable (e.g. GMGN rate
  // limited AND RugCheck down) — avoid writing empty rows.
  const hasSignal = Boolean(rugcheck?.available) || Boolean(dev)
  if (hasSignal) {
    try {
      await ensureRiskTables()
      await persist({
        chain: params.chain,
        tokenAddress: params.tokenAddress,
        creator,
        rugcheck,
        dev,
        label,
        mode,
      })
      if (creator && dev) {
        await persistDevReputation({ chain: params.chain, creator, dev, mode })
      }
    } catch {
      // best-effort persistence — display still gets the in-memory label
    }
  }

  return { label, rugcheck, dev, creator, mode }
}

export type RiskChip = {
  text: string
  tone: RiskChipTone
  mode: 'shadow' | 'enforce'
  reasons: string[]
}

type RiskRow = {
  token_address?: string
  rugcheck_score_norm: number | null
  rugcheck_risk_names: string[] | null
  dev_verdict: DevVerdict | null
  mode: string | null
  risk_reasons: string[] | null
}

/** Read the stored chip for display (Freeview tiles / API). */
export async function readRiskChip(
  chain: string,
  tokenAddress: string,
): Promise<RiskChip | null> {
  try {
    const row = await queryOne<RiskRow>(
      `SELECT rugcheck_score_norm, rugcheck_risk_names, dev_verdict, mode, risk_reasons
       FROM token_risk_features WHERE chain = $1 AND token_address = $2 LIMIT 1`,
      [chain, tokenAddress],
    )
    if (!row) return null
    return chipFromRow(row)
  } catch {
    return null
  }
}

/** Bulk read for list surfaces — one query for many tokens. */
export async function readRiskChips(
  chain: string,
  addresses: string[],
): Promise<Record<string, RiskChip>> {
  const list = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))]
  if (list.length === 0) return {}
  try {
    const { rows } = await query<RiskRow>(
      `SELECT token_address, rugcheck_score_norm, rugcheck_risk_names, dev_verdict, mode, risk_reasons
       FROM token_risk_features
       WHERE chain = $1 AND token_address = ANY($2)
       LIMIT 500`,
      [chain, list],
    )
    const out: Record<string, RiskChip> = {}
    for (const row of rows) {
      const chip = chipFromRow(row)
      if (chip && row.token_address) out[row.token_address] = chip
    }
    return out
  } catch {
    return {}
  }
}

function chipFromRow(row: RiskRow): RiskChip | null {
  const mode = row.mode === 'enforce' ? 'enforce' : 'shadow'
  const parts: string[] = []
  if (row.dev_verdict && row.dev_verdict !== 'unknown') parts.push(`dev ${row.dev_verdict}`)
  if (row.rugcheck_score_norm != null) {
    const risks = (row.rugcheck_risk_names ?? []).slice(0, 2).join(', ')
    parts.push(`${Math.round(row.rugcheck_score_norm)}/100${risks ? ` · ${risks}` : ''}`)
  }
  if (parts.length === 0) return null
  const tone: RiskChipTone =
    row.dev_verdict === 'ban' ? 'red' : row.dev_verdict === 'good' ? 'emerald' : 'gray'
  return {
    text: `${parts.join(' · ')}${mode === 'shadow' ? ' (shadow)' : ''}`,
    tone,
    mode,
    reasons: row.risk_reasons ?? [],
  }
}

export type DevReputationRow = {
  creator_address: string
  verdict: DevVerdict
  sample: number
  open_count: number
  inner_count: number
  graduation_ratio: number | null
  ath_mc: number | null
  reasons: string[]
  tokens: DevTokenRef[] | null
  mode: string
  evaluated_at: string
}

/** Dev list for observability (`GET /api/dev/reputation`). */
export async function listDevReputation(
  verdict?: DevVerdict,
  limit = 100,
): Promise<DevReputationRow[]> {
  try {
    return await queryMany(verdict, limit)
  } catch {
    return []
  }
}

async function queryMany(
  verdict: DevVerdict | undefined,
  limit: number,
): Promise<DevReputationRow[]> {
  const cap = Math.min(Math.max(Math.floor(limit), 1), 500)
  const COLS = `creator_address, verdict, sample, open_count, inner_count,
    graduation_ratio, ath_mc, reasons, tokens, mode, evaluated_at`
  const { rows } = verdict
    ? await query<DevReputationRow>(
        `SELECT ${COLS} FROM dev_reputation WHERE verdict = $1
         ORDER BY ath_mc DESC NULLS LAST, evaluated_at DESC LIMIT $2`,
        [verdict, cap],
      )
    : await query<DevReputationRow>(
        `SELECT ${COLS} FROM dev_reputation
         ORDER BY ath_mc DESC NULLS LAST, evaluated_at DESC LIMIT $1`,
        [cap],
      )
  return rows
}
