import { supabase } from '@/utils/supabase'
import type {
  StrategyDefinitionRow,
  StrategyDomain,
  StrategyOutcomeRow,
  TrendingBotStrategyOverride,
} from './types'

export async function loadStrategyDefinitionRows(
  domain: StrategyDomain = 'trending_bot',
): Promise<StrategyDefinitionRow[]> {
  const { data, error } = await supabase
    .from('strategy_definitions')
    .select('*')
    .eq('domain', domain)

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return []
    }
    console.warn('[strategies/db] load failed:', error.message)
    return []
  }

  return (data ?? []) as StrategyDefinitionRow[]
}

export async function upsertStrategyDefinition(params: {
  id: string
  domain: StrategyDomain
  name: string
  description?: string | null
  config: TrendingBotStrategyOverride
  is_active: boolean
}): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('strategy_definitions').upsert(
    {
      id: params.id,
      domain: params.domain,
      name: params.name,
      description: params.description ?? null,
      config: params.config,
      is_active: params.is_active,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  )

  if (error) {
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

export async function insertStrategyOutcome(params: {
  strategy_id: string
  domain: StrategyDomain
  token_address: string
  entry_at?: string | null
  exit_at?: string | null
  pnl_pct?: number | null
  status?: string | null
  features?: Record<string, unknown> | null
}): Promise<void> {
  const { error } = await supabase.from('strategy_outcomes').insert({
    strategy_id: params.strategy_id,
    domain: params.domain,
    token_address: params.token_address,
    entry_at: params.entry_at ?? null,
    exit_at: params.exit_at ?? new Date().toISOString(),
    pnl_pct: params.pnl_pct ?? null,
    status: params.status ?? null,
    features: params.features ?? null,
  })

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return
    }
    console.warn('[strategies/db] outcome insert failed:', error.message)
  }
}

export async function listStrategyOutcomes(params: {
  strategyId?: string
  limit?: number
  offset?: number
}): Promise<{ rows: StrategyOutcomeRow[]; total: number }> {
  const limit = params.limit ?? 50
  const offset = params.offset ?? 0

  let query = supabase
    .from('strategy_outcomes')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (params.strategyId) {
    query = query.eq('strategy_id', params.strategyId)
  }

  const { data, error, count } = await query

  if (error) {
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return { rows: [], total: 0 }
    }
    throw error
  }

  return { rows: (data ?? []) as StrategyOutcomeRow[], total: count ?? 0 }
}
