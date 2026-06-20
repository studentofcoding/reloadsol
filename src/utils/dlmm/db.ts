import { supabase } from '@/utils/supabase';
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

export async function getAgentConfig(): Promise<DlmmAgentConfig> {
  try {
    const { data, error } = await supabase
      .from('dlmm_agent_config')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      const defaults = defaultAgentConfig();
      const { data: inserted, error: insertError } = await supabase
        .from('dlmm_agent_config')
        .insert(defaults)
        .select('*')
        .single();
      if (insertError) throw insertError;
      clearDlmmDbStatusCache();
      return mapAgentConfig(inserted);
    }

    clearDlmmDbStatusCache();
    return mapAgentConfig(data);
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
        'Cannot save config — Supabase is unavailable. Fix .env and apply supabase/schema.sql.',
      );
    }

    const { data, error } = await supabase
      .from('dlmm_agent_config')
      .update({
        ...patch,
        updated_at: new Date().toISOString(),
      })
      .eq('id', current.id)
      .select('*')
      .single();

    if (error) throw error;
    clearDlmmDbStatusCache();
    return mapAgentConfig(data);
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
    const { error } = await supabase.from('dlmm_candidates').insert(rows);
    if (error) throw error;
    clearDlmmDbStatusCache();
  } catch (error) {
    console.warn('[dlmm/db] saveCandidates skipped:', formatDbError(error));
  }
}

export async function getLatestCandidates(limit = 20): Promise<DlmmScreenCandidate[]> {
  try {
    const { data, error } = await supabase
      .from('dlmm_candidates')
      .select('*')
      .order('screened_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data ?? []).map((row) => ({
      pool_address: row.pool_address,
      pool_name: row.pool_name,
      token_x_symbol: row.token_x_symbol,
      token_y_symbol: row.token_y_symbol,
      tvl: Number(row.tvl),
      fee_tvl_ratio_24h: Number(row.fee_tvl_ratio_24h),
      organic_score: Number(row.organic_score),
      holders: Number(row.holders),
      mcap: Number(row.mcap),
      score: Number(row.score),
      screened_at: row.screened_at,
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
    const { data, error } = await supabase
      .from('dlmm_potential_list')
      .select('*')
      .order('added_at', { ascending: false });

    if (error) throw error;
    return (data ?? []).map(mapPotentialEntry);
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
    const { data, error } = await supabase
      .from('dlmm_potential_list')
      .upsert(
        {
          token_address: input.token_address,
          token_symbol: input.token_symbol ?? null,
          source: input.source,
          notes: input.notes ?? null,
          added_at: new Date().toISOString(),
        },
        { onConflict: 'token_address' },
      )
      .select('*')
      .single();

    if (error) throw error;
    clearDlmmDbStatusCache();
    return mapPotentialEntry(data);
  } catch (error) {
    assertDbWritable(error);
  }
}

export async function removePotentialEntry(tokenAddress: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('dlmm_potential_list')
      .delete()
      .eq('token_address', tokenAddress);
    if (error) throw error;
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
    let query = supabase
      .from('dlmm_positions')
      .select('*')
      .order('updated_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map(mapPosition);
  } catch (error) {
    logDbReadFallback('getPositions', error);
    return [];
  }
}

export async function getPositionById(id: string): Promise<DlmmPosition | null> {
  try {
    const { data, error } = await supabase
      .from('dlmm_positions')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? mapPosition(data) : null;
  } catch (error) {
    logDbReadFallback('getPositionById', error);
    return null;
  }
}

export async function insertPosition(
  row: Partial<DlmmPosition>,
): Promise<DlmmPosition> {
  try {
    const { data, error } = await supabase
      .from('dlmm_positions')
      .insert({
        pool_address: row.pool_address,
        pool_name: row.pool_name,
        position_pubkey: row.position_pubkey,
        token_x_symbol: row.token_x_symbol,
        token_y_symbol: row.token_y_symbol,
        amount_sol: row.amount_sol ?? 0,
        min_bin_id: row.min_bin_id,
        max_bin_id: row.max_bin_id,
        entry_value_usd: row.entry_value_usd ?? 0,
        current_value_usd: row.current_value_usd ?? row.entry_value_usd ?? 0,
        fees_earned_usd: row.fees_earned_usd ?? 0,
        pnl_pct: row.pnl_pct ?? 0,
        status: row.status ?? 'open',
        is_muted: row.is_muted ?? false,
        take_profit_pct: row.take_profit_pct,
        stop_loss_pct: row.stop_loss_pct,
        oor_timeout_min: row.oor_timeout_min,
        tx_signature: row.tx_signature,
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();
    if (error) throw error;
    clearDlmmDbStatusCache();
    return mapPosition(data);
  } catch (error) {
    assertDbWritable(error);
  }
}

export async function updatePosition(
  id: string,
  patch: Partial<DlmmPosition>,
): Promise<DlmmPosition> {
  try {
    const { data, error } = await supabase
      .from('dlmm_positions')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    clearDlmmDbStatusCache();
    return mapPosition(data);
  } catch (error) {
    assertDbWritable(error);
  }
}

export async function getOpenSolAtRisk(): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('dlmm_positions')
      .select('amount_sol')
      .in('status', ['open', 'out_of_range', 'pending']);
    if (error) throw error;
    return (data ?? []).reduce((sum, row) => sum + Number(row.amount_sol || 0), 0);
  } catch (error) {
    logDbReadFallback('getOpenSolAtRisk', error);
    return 0;
  }
}

export async function appendLesson(
  lesson: Omit<DlmmLesson, 'id' | 'created_at'>,
): Promise<void> {
  try {
    const { error } = await supabase.from('dlmm_lessons').insert({
      position_id: lesson.position_id,
      pool_address: lesson.pool_address,
      decision: lesson.decision,
      reason: lesson.reason,
      pnl_pct: lesson.pnl_pct,
      fee_tvl_at_entry: lesson.fee_tvl_at_entry,
    });
    if (error) throw error;
  } catch (error) {
    console.warn('[dlmm/db] appendLesson skipped:', formatDbError(error));
  }
}

export async function getRecentLessons(limit = 20): Promise<DlmmLesson[]> {
  try {
    const { data, error } = await supabase
      .from('dlmm_lessons')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: String(row.id),
      position_id: row.position_id ? String(row.position_id) : null,
      pool_address: String(row.pool_address),
      decision: row.decision,
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
