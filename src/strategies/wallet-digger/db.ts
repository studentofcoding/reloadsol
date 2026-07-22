import { query, queryOne } from '@/utils/db'

export type RosterStatus = 'candidate' | 'active' | 'needs_follow' | 'demoted' | 'banned'
export type FollowStatus = 'needs_follow' | 'followed' | 'unfollowed'

export type AlphaWalletRosterRow = {
  address: string
  status: RosterStatus
  follow_status: FollowStatus
  score: number
  runner_hits: number
  portfolio: Record<string, unknown> | null
  notes: string | null
  promoted_at: Date | null
  demoted_at: Date | null
  banned_at: Date | null
  created_at: Date
  updated_at: Date
}

export type AlphaDigRunRow = {
  id: number
  started_at: Date
  finished_at: Date | null
  runner_tokens: unknown
  traders_seen: number
  promoted: number
  demoted: number
  errors: unknown
}

export type AlphaConcurrenceSignalRow = {
  id: number
  token_address: string
  symbol: string | null
  makers: string[]
  window_sec: number
  first_trade_at: Date
  last_trade_at: Date
  fired_at: Date
  market_cap_usd: number | null
  telegram_sent: boolean
  sim_opened: boolean
  skip_reason: string | null
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS alpha_wallet_roster (
  address TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'active', 'needs_follow', 'demoted', 'banned')),
  follow_status TEXT NOT NULL DEFAULT 'needs_follow'
    CHECK (follow_status IN ('needs_follow', 'followed', 'unfollowed')),
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  runner_hits INT NOT NULL DEFAULT 0,
  portfolio JSONB,
  notes TEXT,
  promoted_at TIMESTAMPTZ,
  demoted_at TIMESTAMPTZ,
  banned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS alpha_wallet_dig_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  runner_tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
  traders_seen INT NOT NULL DEFAULT 0,
  promoted INT NOT NULL DEFAULT 0,
  demoted INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE IF NOT EXISTS alpha_wallet_dig_hits (
  id BIGSERIAL PRIMARY KEY,
  dig_run_id BIGINT REFERENCES alpha_wallet_dig_runs (id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  profit_usd DOUBLE PRECISION,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dig_run_id, wallet_address, token_address)
);
CREATE TABLE IF NOT EXISTS alpha_roster_trade_events (
  id BIGSERIAL PRIMARY KEY,
  maker TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT 'buy',
  amount_usd DOUBLE PRECISION,
  price_usd DOUBLE PRECISION,
  symbol TEXT,
  trade_at TIMESTAMPTZ NOT NULL,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_roster_trade_events_tx
  ON alpha_roster_trade_events (tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alpha_roster_trade_events_window
  ON alpha_roster_trade_events (token_address, trade_at DESC);
CREATE TABLE IF NOT EXISTS alpha_concurrence_signals (
  id BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL,
  symbol TEXT,
  makers TEXT[] NOT NULL,
  window_sec INT NOT NULL,
  first_trade_at TIMESTAMPTZ NOT NULL,
  last_trade_at TIMESTAMPTZ NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_cap_usd DOUBLE PRECISION,
  telegram_sent BOOLEAN NOT NULL DEFAULT FALSE,
  sim_opened BOOLEAN NOT NULL DEFAULT FALSE,
  skip_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_alpha_concurrence_signals_token_fired
  ON alpha_concurrence_signals (token_address, fired_at DESC);
`

let ensured = false

export async function ensureWalletDiggerTables(): Promise<void> {
  if (ensured) return
  await query(ENSURE_SQL)
  ensured = true
}

export async function listRoster(params?: {
  status?: RosterStatus | RosterStatus[]
  limit?: number
}): Promise<AlphaWalletRosterRow[]> {
  await ensureWalletDiggerTables()
  const limit = Math.min(Math.max(params?.limit ?? 200, 1), 500)
  const statuses = params?.status
    ? Array.isArray(params.status)
      ? params.status
      : [params.status]
    : null
  if (statuses?.length) {
    const { rows } = await query<AlphaWalletRosterRow>(
      `SELECT * FROM alpha_wallet_roster
       WHERE status = ANY($1::text[])
       ORDER BY score DESC, updated_at DESC
       LIMIT $2`,
      [statuses, limit],
    )
    return rows
  }
  const { rows } = await query<AlphaWalletRosterRow>(
    `SELECT * FROM alpha_wallet_roster
     ORDER BY score DESC, updated_at DESC
     LIMIT $1`,
    [limit],
  )
  return rows
}

/** Soft hybrid: only wallets marked followed on GMGN count for concurrence. */
export async function getFollowedRosterAddresses(): Promise<Set<string>> {
  const rows = await listRoster({ status: ['active', 'needs_follow'], limit: 500 })
  const set = new Set<string>()
  for (const row of rows) {
    if (row.follow_status === 'followed') set.add(row.address)
  }
  return set
}

/** runner_hits for addresses (missing → 0). */
export async function getRosterHitsMap(
  addresses: string[],
): Promise<Map<string, number>> {
  await ensureWalletDiggerTables()
  const out = new Map<string, number>()
  const unique = Array.from(new Set(addresses.map((a) => a.trim()).filter(Boolean)))
  for (const a of unique) out.set(a, 0)
  if (unique.length === 0) return out
  const { rows } = await query<{ address: string; runner_hits: number }>(
    `SELECT address, runner_hits FROM alpha_wallet_roster WHERE address = ANY($1::text[])`,
    [unique],
  )
  for (const row of rows) {
    out.set(row.address, Math.max(0, Number(row.runner_hits) || 0))
  }
  return out
}

export async function upsertRosterCandidate(params: {
  address: string
  score: number
  runnerHits: number
  portfolio?: Record<string, unknown> | null
  promote: boolean
}): Promise<void> {
  await ensureWalletDiggerTables()
  const existing = await queryOne<{ status: RosterStatus }>(
    `SELECT status FROM alpha_wallet_roster WHERE address = $1`,
    [params.address],
  )
  if (existing?.status === 'banned') return

  if (params.promote) {
    await query(
      `INSERT INTO alpha_wallet_roster (
         address, status, follow_status, score, runner_hits, portfolio, promoted_at, updated_at
       ) VALUES ($1, 'needs_follow', 'needs_follow', $2, $3, $4::jsonb, NOW(), NOW())
       ON CONFLICT (address) DO UPDATE SET
         status = CASE
           WHEN alpha_wallet_roster.status = 'banned' THEN 'banned'
           WHEN alpha_wallet_roster.follow_status = 'followed' THEN 'active'
           ELSE 'needs_follow'
         END,
         follow_status = CASE
           WHEN alpha_wallet_roster.follow_status = 'followed' THEN 'followed'
           ELSE 'needs_follow'
         END,
         score = EXCLUDED.score,
         runner_hits = EXCLUDED.runner_hits,
         portfolio = COALESCE(EXCLUDED.portfolio, alpha_wallet_roster.portfolio),
         promoted_at = COALESCE(alpha_wallet_roster.promoted_at, NOW()),
         demoted_at = NULL,
         updated_at = NOW()`,
      [
        params.address,
        params.score,
        params.runnerHits,
        params.portfolio ? JSON.stringify(params.portfolio) : null,
      ],
    )
    return
  }

  await query(
    `INSERT INTO alpha_wallet_roster (address, status, score, runner_hits, portfolio, updated_at)
     VALUES ($1, 'candidate', $2, $3, $4::jsonb, NOW())
     ON CONFLICT (address) DO UPDATE SET
       score = GREATEST(alpha_wallet_roster.score, EXCLUDED.score),
       runner_hits = GREATEST(alpha_wallet_roster.runner_hits, EXCLUDED.runner_hits),
       portfolio = COALESCE(EXCLUDED.portfolio, alpha_wallet_roster.portfolio),
       updated_at = NOW()
     WHERE alpha_wallet_roster.status NOT IN ('banned')`,
    [
      params.address,
      params.score,
      params.runnerHits,
      params.portfolio ? JSON.stringify(params.portfolio) : null,
    ],
  )
}

export async function patchRoster(
  address: string,
  patch: {
    status?: RosterStatus
    follow_status?: FollowStatus
    notes?: string | null
  },
): Promise<AlphaWalletRosterRow | null> {
  await ensureWalletDiggerTables()
  let status = patch.status
  let follow = patch.follow_status
  if (follow === 'followed' && !status) status = 'active'
  return queryOne<AlphaWalletRosterRow>(
    `UPDATE alpha_wallet_roster SET
       status = COALESCE($2, status),
       follow_status = COALESCE($3, follow_status),
       notes = COALESCE($4, notes),
       banned_at = CASE WHEN $2 = 'banned' THEN NOW() ELSE banned_at END,
       demoted_at = CASE WHEN $2 = 'demoted' THEN NOW() ELSE demoted_at END,
       promoted_at = CASE
         WHEN $2 IN ('active', 'needs_follow') THEN COALESCE(promoted_at, NOW())
         ELSE promoted_at
       END,
       updated_at = NOW()
     WHERE address = $1
     RETURNING *`,
    [address, status ?? null, follow ?? null, patch.notes ?? null],
  )
}

export async function demoteExcessRoster(cap: number): Promise<number> {
  await ensureWalletDiggerTables()
  const { rows } = await query<{ address: string }>(
    `SELECT address FROM alpha_wallet_roster
     WHERE status IN ('active', 'needs_follow')
     ORDER BY score DESC, promoted_at ASC NULLS LAST
     OFFSET $1`,
    [Math.max(cap, 0)],
  )
  if (!rows.length) return 0
  await query(
    `UPDATE alpha_wallet_roster
     SET status = 'demoted', demoted_at = NOW(), updated_at = NOW()
     WHERE address = ANY($1::text[])`,
    [rows.map((r) => r.address)],
  )
  return rows.length
}

export async function startDigRun(runnerTokens: string[]): Promise<number> {
  await ensureWalletDiggerTables()
  const row = await queryOne<{ id: number }>(
    `INSERT INTO alpha_wallet_dig_runs (runner_tokens)
     VALUES ($1::jsonb)
     RETURNING id`,
    [JSON.stringify(runnerTokens)],
  )
  return Number(row?.id ?? 0)
}

export async function finishDigRun(
  id: number,
  stats: { tradersSeen: number; promoted: number; demoted: number; errors: string[] },
): Promise<void> {
  await query(
    `UPDATE alpha_wallet_dig_runs SET
       finished_at = NOW(),
       traders_seen = $2,
       promoted = $3,
       demoted = $4,
       errors = $5::jsonb
     WHERE id = $1`,
    [id, stats.tradersSeen, stats.promoted, stats.demoted, JSON.stringify(stats.errors)],
  )
}

export async function insertDigHit(params: {
  digRunId: number
  walletAddress: string
  tokenAddress: string
  profitUsd?: number | null
  tags?: string[]
}): Promise<void> {
  await query(
    `INSERT INTO alpha_wallet_dig_hits (
       dig_run_id, wallet_address, token_address, profit_usd, tags
     ) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (dig_run_id, wallet_address, token_address) DO NOTHING`,
    [
      params.digRunId,
      params.walletAddress,
      params.tokenAddress,
      params.profitUsd ?? null,
      JSON.stringify(params.tags ?? []),
    ],
  )
}

export async function countWalletRunnerHits(
  walletAddress: string,
  sinceHours = 168,
): Promise<number> {
  await ensureWalletDiggerTables()
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(DISTINCT token_address)::text AS n
     FROM alpha_wallet_dig_hits
     WHERE wallet_address = $1
       AND created_at >= NOW() - ($2 * INTERVAL '1 hour')`,
    [walletAddress, sinceHours],
  )
  return Number(row?.n ?? 0)
}

export type DigHitToken = {
  token_address: string
  profit_usd: number | null
}

/** Distinct dig-hit tokens per wallet; profit summed across dig runs. */
export async function listDigHitsForWallets(
  addresses: string[],
): Promise<Record<string, DigHitToken[]>> {
  await ensureWalletDiggerTables()
  const out: Record<string, DigHitToken[]> = {}
  if (!addresses.length) return out

  const { rows } = await query<{
    wallet_address: string
    token_address: string
    profit_usd: number | null
  }>(
    `SELECT wallet_address, token_address, SUM(COALESCE(profit_usd, 0))::float8 AS profit_usd
     FROM alpha_wallet_dig_hits
     WHERE wallet_address = ANY($1::text[])
     GROUP BY wallet_address, token_address
     ORDER BY wallet_address, profit_usd DESC NULLS LAST`,
    [addresses],
  )

  for (const row of rows) {
    const list = out[row.wallet_address] ?? []
    list.push({
      token_address: row.token_address,
      profit_usd: row.profit_usd != null ? Number(row.profit_usd) : null,
    })
    out[row.wallet_address] = list
  }
  return out
}

export type RosterScoreParts = {
  hits: number
  hits_contrib: number
  dig_profit_usd: number
  profit_contrib: number
}

export function buildScoreParts(params: {
  runnerHits: number
  score: number
  hitTokens: DigHitToken[]
}): RosterScoreParts {
  const hits = Math.max(0, Number(params.runnerHits) || 0)
  const hits_contrib = hits * 10
  const summed = params.hitTokens.reduce((acc, t) => {
    const p = t.profit_usd
    if (p == null || !Number.isFinite(p) || p <= 0) return acc
    return acc + p
  }, 0)
  // Prefer summed dig-hit profits; if none recorded, derive from stored score
  const dig_profit_usd =
    params.hitTokens.length > 0
      ? summed
      : Math.max(0, (Number(params.score) || 0) - hits_contrib) * 1000
  const profit_contrib = dig_profit_usd / 1000
  return { hits, hits_contrib, dig_profit_usd, profit_contrib }
}

export async function insertRosterTradeEvents(
  events: Array<{
    maker: string
    tokenAddress: string
    side?: string
    amountUsd?: number | null
    priceUsd?: number | null
    symbol?: string | null
    tradeAt: Date
    txHash?: string | null
  }>,
): Promise<number> {
  await ensureWalletDiggerTables()
  let n = 0
  for (const e of events) {
    if (e.txHash) {
      const { rowCount } = await query(
        `INSERT INTO alpha_roster_trade_events (
           maker, token_address, side, amount_usd, price_usd, symbol, trade_at, tx_hash
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8
         WHERE NOT EXISTS (
           SELECT 1 FROM alpha_roster_trade_events WHERE tx_hash = $8
         )`,
        [
          e.maker,
          e.tokenAddress,
          e.side ?? 'buy',
          e.amountUsd ?? null,
          e.priceUsd ?? null,
          e.symbol ?? null,
          e.tradeAt.toISOString(),
          e.txHash,
        ],
      )
      n += rowCount
    } else {
      await query(
        `INSERT INTO alpha_roster_trade_events (
           maker, token_address, side, amount_usd, price_usd, symbol, trade_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          e.maker,
          e.tokenAddress,
          e.side ?? 'buy',
          e.amountUsd ?? null,
          e.priceUsd ?? null,
          e.symbol ?? null,
          e.tradeAt.toISOString(),
        ],
      )
      n += 1
    }
  }
  await query(`DELETE FROM alpha_roster_trade_events WHERE trade_at < NOW() - INTERVAL '2 hours'`)
  return n
}

export async function fetchRecentRosterBuys(windowSec: number): Promise<
  Array<{
    maker: string
    token_address: string
    trade_at: Date
    amount_usd: number | null
    symbol: string | null
  }>
> {
  await ensureWalletDiggerTables()
  const { rows } = await query<{
    maker: string
    token_address: string
    trade_at: Date
    amount_usd: number | null
    symbol: string | null
  }>(
    `SELECT maker, token_address, trade_at, amount_usd, symbol
     FROM alpha_roster_trade_events
     WHERE side = 'buy'
       AND trade_at >= NOW() - ($1 * INTERVAL '1 second')
     ORDER BY trade_at ASC`,
    [windowSec],
  )
  return rows
}

export async function hasRecentConcurrenceSignal(
  tokenAddress: string,
  withinHours = 6,
): Promise<boolean> {
  await ensureWalletDiggerTables()
  const row = await queryOne<{ id: number }>(
    `SELECT id FROM alpha_concurrence_signals
     WHERE token_address = $1
       AND fired_at >= NOW() - ($2 * INTERVAL '1 hour')
     LIMIT 1`,
    [tokenAddress, withinHours],
  )
  return Boolean(row)
}

export async function insertConcurrenceSignal(params: {
  tokenAddress: string
  symbol?: string | null
  makers: string[]
  windowSec: number
  firstTradeAt: Date
  lastTradeAt: Date
  marketCapUsd?: number | null
  telegramSent?: boolean
  simOpened?: boolean
  skipReason?: string | null
}): Promise<number> {
  await ensureWalletDiggerTables()
  const row = await queryOne<{ id: number }>(
    `INSERT INTO alpha_concurrence_signals (
       token_address, symbol, makers, window_sec, first_trade_at, last_trade_at,
       market_cap_usd, telegram_sent, sim_opened, skip_reason
     ) VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      params.tokenAddress,
      params.symbol ?? null,
      params.makers,
      params.windowSec,
      params.firstTradeAt.toISOString(),
      params.lastTradeAt.toISOString(),
      params.marketCapUsd ?? null,
      params.telegramSent ?? false,
      params.simOpened ?? false,
      params.skipReason ?? null,
    ],
  )
  return Number(row?.id ?? 0)
}

export async function updateConcurrenceSignalFlags(
  id: number,
  flags: { telegramSent?: boolean; simOpened?: boolean; skipReason?: string | null },
): Promise<void> {
  await query(
    `UPDATE alpha_concurrence_signals SET
       telegram_sent = COALESCE($2, telegram_sent),
       sim_opened = COALESCE($3, sim_opened),
       skip_reason = COALESCE($4, skip_reason)
     WHERE id = $1`,
    [id, flags.telegramSent ?? null, flags.simOpened ?? null, flags.skipReason ?? null],
  )
}

export async function listRecentDigRuns(limit = 20): Promise<AlphaDigRunRow[]> {
  await ensureWalletDiggerTables()
  const { rows } = await query<AlphaDigRunRow>(
    `SELECT * FROM alpha_wallet_dig_runs ORDER BY started_at DESC LIMIT $1`,
    [Math.min(limit, 100)],
  )
  return rows
}

export async function listRecentConcurrenceSignals(
  limit = 50,
): Promise<AlphaConcurrenceSignalRow[]> {
  await ensureWalletDiggerTables()
  const { rows } = await query<AlphaConcurrenceSignalRow>(
    `SELECT * FROM alpha_concurrence_signals ORDER BY fired_at DESC LIMIT $1`,
    [Math.min(limit, 200)],
  )
  return rows
}

export async function fetchWonOutcomeMints(params: {
  sinceHours: number
  limit: number
}): Promise<string[]> {
  const { rows } = await query<{ token_address: string }>(
    `SELECT DISTINCT token_address
     FROM strategy_outcomes
     WHERE status = 'won'
       AND token_address IS NOT NULL
       AND created_at >= NOW() - ($1 * INTERVAL '1 hour')
     LIMIT $2`,
    [params.sinceHours, params.limit],
  )
  return rows.map((r) => r.token_address).filter(Boolean)
}
