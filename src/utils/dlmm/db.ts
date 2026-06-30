import { query, queryOne } from '@/utils/db';
import type {
  DlmmAgentConfig,
  DlmmLesson,
  DlmmPosition,
  DlmmPotentialEntry,
  DlmmPotentialSource,
  DlmmScreenCandidate,
} from '@/types/dlmm';
import { defaultAgentConfig } from '@/utils/dlmm/config';
import {
  DbUnavailableError,
  assertDbWritable,
  formatDbError,
  isDbConnectivityError,
} from '@/utils/db-health';
import { clearDlmmDbStatusCache } from '@/utils/dlmm/db-status';

const CONFIG_ID_CACHE = 'singleton';

function envFallbackConfig(): DlmmAgentConfig {
  return {
    id: 'env-fallback',
    ...defaultAgentConfig(),
    updated_at: new Date().toISOString(),
  };
}

function logDbReadFallback(fn: string, error: unknown) {
  console.warn(`[dlmm/db] ${fn} fallback:`, formatDbError(error));
}

function buildSetClause(
  patch: Record<string, unknown>,
  skip: Set<string>,
): { setSql: string; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(patch)) {
    if (skip.has(key) || value === undefined) continue;
    sets.push(`${key} = $${i++}`);
    values.push(value);
  }
  return { setSql: sets.join(', '), values };
}

export async function getAgentConfig(): Promise<DlmmAgentConfig> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM dlmm_agent_config
       ORDER BY updated_at DESC
       LIMIT 1`,
    );

    if (!row) {
      const defaults = defaultAgentConfig();
      const inserted = await queryOne<Record<string, unknown>>(
        `INSERT INTO dlmm_agent_config (
           enabled, dry_run, min_tvl, min_fee_tvl, min_organic_score, min_holders,
           take_profit_pct, stop_loss_pct, oor_timeout_min, max_sol_per_position,
           max_sol_at_risk, bin_range_interval, muted_positions, use_llm_reasoner
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          defaults.enabled,
          defaults.dry_run,
          defaults.min_tvl,
          defaults.min_fee_tvl,
          defaults.min_organic_score,
          defaults.min_holders,
          defaults.take_profit_pct,
          defaults.stop_loss_pct,
          defaults.oor_timeout_min,
          defaults.max_sol_per_position,
          defaults.max_sol_at_risk,
          defaults.bin_range_interval,
          defaults.muted_positions,
          defaults.use_llm_reasoner,
        ],
      );
      if (!inserted) throw new Error('Insert failed');
      clearDlmmDbStatusCache();
      return mapAgentConfig(inserted);
    }

    clearDlmmDbStatusCache();
    return mapAgentConfig(row);
  } catch (error) {
    if (isDbConnectivityError(error) || formatDbError(error).includes('missing')) {
      logDbReadFallback('getAgentConfig', error);
      return envFallbackConfig();
    }
    logDbReadFallback('getAgentConfig', error);
    return envFallbackConfig();
  }
}

function mapAgentConfig(row: Record<string, unknown>): DlmmAgentConfig {
  return {
    id: String(row.id),
    enabled: Boolean(row.enabled),
    dry_run: Boolean(row.dry_run),
    min_tvl: Number(row.min_tvl),
    min_fee_tvl: Number(row.min_fee_tvl),
    min_organic_score: Number(row.min_organic_score),
    min_holders: Number(row.min_holders),
    take_profit_pct: Number(row.take_profit_pct),
    stop_loss_pct: Number(row.stop_loss_pct),
    oor_timeout_min: Number(row.oor_timeout_min),
    max_sol_per_position: Number(row.max_sol_per_position),
    max_sol_at_risk: Number(row.max_sol_at_risk),
    bin_range_interval: Number(row.bin_range_interval),
    muted_positions: Array.isArray(row.muted_positions)
      ? (row.muted_positions as string[])
      : [],
    use_llm_reasoner: Boolean(row.use_llm_reasoner),
    updated_at: String(row.updated_at),
  };
}

export async function updateAgentConfig(
  patch: Partial<DlmmAgentConfig>,
): Promise<DlmmAgentConfig> {
  try {
    const current = await getAgentConfig();
    if (current.id === 'env-fallback') {
      throw new DbUnavailableError(
        'Cannot save config — database unavailable. Fix DATABASE_URL and apply db/init schema.',
      );
    }

    const { setSql, values } = buildSetClause(
      patch as Record<string, unknown>,
      new Set(['id', 'updated_at']),
    );
    const updatedAt = new Date().toISOString();
    const params = setSql
      ? [...values, updatedAt, current.id]
      : [updatedAt, current.id];
    const setClause = setSql
      ? `${setSql}, updated_at = $${values.length + 1}`
      : 'updated_at = $1';

    const row = await queryOne<Record<string, unknown>>(
      `UPDATE dlmm_agent_config SET ${setClause}
       WHERE id = $${params.length}
       RETURNING *`,
      params,
    );
    if (!row) throw new Error('Config not found');
    clearDlmmDbStatusCache();
    return mapAgentConfig(row);
  } catch (error) {
    if (error instanceof DbUnavailableError) throw error;
    assertDbWritable(error);
  }
}

export async function saveCandidates(candidates: DlmmScreenCandidate[]): Promise<void> {
  if (candidates.length === 0) return;
  const rows = candidates.map((c) => ({
    pool_address: c.pool_address,
    pool_name: c.pool_name,
    token_x_symbol: c.token_x_symbol,
    token_y_symbol: c.token_y_symbol,
    tvl: c.tvl,
    fee_tvl_ratio_24h: c.fee_tvl_ratio_24h,
    organic_score: c.organic_score,
    holders: c.holders,
    mcap: c.mcap,
    score: c.score,
    screened_at: c.screened_at,
  }));
  try {
    const values: unknown[] = [];
    const placeholders = rows.map((row, i) => {
      const base = i * 11;
      values.push(
        row.pool_address,
        row.pool_name,
        row.token_x_symbol,
        row.token_y_symbol,
        row.tvl,
        row.fee_tvl_ratio_24h,
        row.organic_score,
        row.holders,
        row.mcap,
        row.score,
        row.screened_at,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
    });
    await query(
      `INSERT INTO dlmm_candidates (
         pool_address, pool_name, token_x_symbol, token_y_symbol, tvl,
         fee_tvl_ratio_24h, organic_score, holders, mcap, score, screened_at
       ) VALUES ${placeholders.join(', ')}`,
      values,
    );
    clearDlmmDbStatusCache();
  } catch (error) {
    console.warn('[dlmm/db] saveCandidates skipped:', formatDbError(error));
  }
}

export async function getLatestCandidates(limit = 20): Promise<DlmmScreenCandidate[]> {
  try {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM dlmm_candidates
       ORDER BY screened_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      pool_address: String(row.pool_address),
      pool_name: row.pool_name ? String(row.pool_name) : '',
      token_x_symbol: row.token_x_symbol ? String(row.token_x_symbol) : '',
      token_y_symbol: row.token_y_symbol ? String(row.token_y_symbol) : '',
      tvl: Number(row.tvl),
      fee_tvl_ratio_24h: Number(row.fee_tvl_ratio_24h),
      organic_score: Number(row.organic_score),
      holders: Number(row.holders),
      mcap: Number(row.mcap),
      score: Number(row.score),
      screened_at: String(row.screened_at),
    }));
  } catch (error) {
    logDbReadFallback('getLatestCandidates', error);
    return [];
  }
}

function mapPotentialEntry(row: Record<string, unknown>): DlmmPotentialEntry {
  return {
    id: String(row.id),
    token_address: String(row.token_address),
    token_symbol: row.token_symbol ? String(row.token_symbol) : null,
    source: row.source as DlmmPotentialSource,
    notes: row.notes ? String(row.notes) : null,
    added_at: String(row.added_at),
  };
}

export async function getPotentialList(): Promise<DlmmPotentialEntry[]> {
  try {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM dlmm_potential_list ORDER BY added_at DESC`,
    );
    return rows.map(mapPotentialEntry);
  } catch (error) {
    logDbReadFallback('getPotentialList', error);
    return [];
  }
}

export async function addPotentialEntry(input: {
  token_address: string;
  token_symbol?: string | null;
  source: DlmmPotentialSource;
  notes?: string | null;
}): Promise<DlmmPotentialEntry> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO dlmm_potential_list (token_address, token_symbol, source, notes, added_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_address) DO UPDATE SET
         token_symbol = EXCLUDED.token_symbol,
         source = EXCLUDED.source,
         notes = EXCLUDED.notes,
         added_at = EXCLUDED.added_at
       RETURNING *`,
      [
        input.token_address,
        input.token_symbol ?? null,
        input.source,
        input.notes ?? null,
        new Date().toISOString(),
      ],
    );
    if (!row) throw new Error('Upsert failed');
    clearDlmmDbStatusCache();
    return mapPotentialEntry(row);
  } catch (error) {
    assertDbWritable(error);
  }
}

export async function removePotentialEntry(tokenAddress: string): Promise<void> {
  try {
    await query(`DELETE FROM dlmm_potential_list WHERE token_address = $1`, [
      tokenAddress,
    ]);
    clearDlmmDbStatusCache();
  } catch (error) {
    assertDbWritable(error);
  }
}

function mapPosition(row: Record<string, unknown>): DlmmPosition {
  return {
    id: String(row.id),
    pool_address: String(row.pool_address),
    pool_name: row.pool_name ? String(row.pool_name) : '',
    position_pubkey: row.position_pubkey ? String(row.position_pubkey) : null,
    token_x_symbol: row.token_x_symbol ? String(row.token_x_symbol) : '',
    token_y_symbol: row.token_y_symbol ? String(row.token_y_symbol) : '',
    amount_sol: Number(row.amount_sol),
    min_bin_id: row.min_bin_id != null ? Number(row.min_bin_id) : null,
    max_bin_id: row.max_bin_id != null ? Number(row.max_bin_id) : null,
    entry_value_usd: Number(row.entry_value_usd),
    current_value_usd: Number(row.current_value_usd),
    fees_earned_usd: Number(row.fees_earned_usd),
    pnl_pct: Number(row.pnl_pct),
    status: row.status as DlmmPosition['status'],
    is_muted: Boolean(row.is_muted),
    oor_since: row.oor_since ? String(row.oor_since) : null,
    take_profit_pct: Number(row.take_profit_pct),
    stop_loss_pct: Number(row.stop_loss_pct),
    oor_timeout_min: Number(row.oor_timeout_min),
    last_decision: row.last_decision as DlmmPosition['last_decision'],
    last_decision_reason: row.last_decision_reason ? String(row.last_decision_reason) : null,
    last_decision_at: row.last_decision_at ? String(row.last_decision_at) : null,
    tx_signature: row.tx_signature ? String(row.tx_signature) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    closed_at: row.closed_at ? String(row.closed_at) : null,
  };
}

export async function getPositions(status?: string): Promise<DlmmPosition[]> {
  try {
    const { rows } = status
      ? await query<Record<string, unknown>>(
          `SELECT * FROM dlmm_positions
           WHERE status = $1
           ORDER BY updated_at DESC`,
          [status],
        )
      : await query<Record<string, unknown>>(
          `SELECT * FROM dlmm_positions ORDER BY updated_at DESC`,
        );
    return rows.map(mapPosition);
  } catch (error) {
    logDbReadFallback('getPositions', error);
    return [];
  }
}

export async function getPositionById(id: string): Promise<DlmmPosition | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM dlmm_positions WHERE id = $1`,
      [id],
    );
    return row ? mapPosition(row) : null;
  } catch (error) {
    logDbReadFallback('getPositionById', error);
    return null;
  }
}

export async function insertPosition(
  row: Partial<DlmmPosition>,
): Promise<DlmmPosition> {
  try {
    const inserted = await queryOne<Record<string, unknown>>(
      `INSERT INTO dlmm_positions (
         pool_address, pool_name, position_pubkey, token_x_symbol, token_y_symbol,
         amount_sol, min_bin_id, max_bin_id, entry_value_usd, current_value_usd,
         fees_earned_usd, pnl_pct, status, is_muted, take_profit_pct, stop_loss_pct,
         oor_timeout_min, tx_signature, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        row.pool_address,
        row.pool_name,
        row.position_pubkey,
        row.token_x_symbol,
        row.token_y_symbol,
        row.amount_sol ?? 0,
        row.min_bin_id,
        row.max_bin_id,
        row.entry_value_usd ?? 0,
        row.current_value_usd ?? row.entry_value_usd ?? 0,
        row.fees_earned_usd ?? 0,
        row.pnl_pct ?? 0,
        row.status ?? 'open',
        row.is_muted ?? false,
        row.take_profit_pct,
        row.stop_loss_pct,
        row.oor_timeout_min,
        row.tx_signature,
        new Date().toISOString(),
      ],
    );
    if (!inserted) throw new Error('Insert failed');
    clearDlmmDbStatusCache();
    return mapPosition(inserted);
  } catch (error) {
    assertDbWritable(error);
  }
}

export async function updatePosition(
  id: string,
  patch: Partial<DlmmPosition>,
): Promise<DlmmPosition> {
  try {
    const { setSql, values } = buildSetClause(
      patch as Record<string, unknown>,
      new Set(['id', 'updated_at']),
    );
    const updatedAt = new Date().toISOString();
    const params = setSql
      ? [...values, updatedAt, id]
      : [updatedAt, id];
    const setClause = setSql
      ? `${setSql}, updated_at = $${values.length + 1}`
      : 'updated_at = $1';

    const row = await queryOne<Record<string, unknown>>(
      `UPDATE dlmm_positions SET ${setClause}
       WHERE id = $${params.length}
       RETURNING *`,
      params,
    );
    if (!row) throw new Error('Position not found');
    clearDlmmDbStatusCache();
    return mapPosition(row);
  } catch (error) {
    assertDbWritable(error);
  }
}

export async function getOpenSolAtRisk(): Promise<number> {
  try {
    const { rows } = await query<{ amount_sol: number | string | null }>(
      `SELECT amount_sol FROM dlmm_positions
       WHERE status IN ('open', 'out_of_range', 'pending')`,
    );
    return rows.reduce((sum, row) => sum + Number(row.amount_sol || 0), 0);
  } catch (error) {
    logDbReadFallback('getOpenSolAtRisk', error);
    return 0;
  }
}

export async function appendLesson(
  lesson: Omit<DlmmLesson, 'id' | 'created_at'>,
): Promise<void> {
  try {
    await query(
      `INSERT INTO dlmm_lessons (
         position_id, pool_address, decision, reason, pnl_pct, fee_tvl_at_entry
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        lesson.position_id,
        lesson.pool_address,
        lesson.decision,
        lesson.reason,
        lesson.pnl_pct,
        lesson.fee_tvl_at_entry,
      ],
    );
  } catch (error) {
    console.warn('[dlmm/db] appendLesson skipped:', formatDbError(error));
  }
}

export async function getRecentLessons(limit = 20): Promise<DlmmLesson[]> {
  try {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM dlmm_lessons
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: String(row.id),
      position_id: row.position_id ? String(row.position_id) : null,
      pool_address: String(row.pool_address),
      decision: row.decision as DlmmLesson['decision'],
      reason: String(row.reason),
      pnl_pct: row.pnl_pct != null ? Number(row.pnl_pct) : null,
      fee_tvl_at_entry: row.fee_tvl_at_entry != null ? Number(row.fee_tvl_at_entry) : null,
      created_at: String(row.created_at),
    }));
  } catch (error) {
    logDbReadFallback('getRecentLessons', error);
    return [];
  }
}

export { CONFIG_ID_CACHE };
