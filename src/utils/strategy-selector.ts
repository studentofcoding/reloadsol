import { supabase } from '@/utils/supabase'
import { TradingStrategy, TokenFilters, TradingParameters } from '@/types/trading-strategies'

// Table names
const STRATEGIES_TABLE = process.env.NODE_ENV === 'development' ? 'trading_strategies_dev' : 'trading_strategies'
const TRACKED_TOKENS_TABLE = process.env.NODE_ENV === 'development' ? 'tracked_tokens_dev' : 'tracked_tokens'

interface TokenData {
  address: string
  symbol: string
  name: string
  price: number
  market_cap: number
  volume_1h: number
  price_change_5m: number
  price_change_1h: number
  organic_score: number
  net_buyers_1h: number
  [key: string]: any
}

interface StrategySelection {
  strategy: TradingStrategy
  confidence: number
  reason: string
}

/**
 * Get all enabled trading strategies
 */
export async function getEnabledStrategies(): Promise<TradingStrategy[]> {
  try {
    const { data, error } = await supabase
      .from(STRATEGIES_TABLE)
      .select('*')
      .eq('enabled', true)
      .order('created_at', { ascending: false })
    
    if (error) {
      console.error('❌ Error fetching enabled strategies:', error)
      return []
    }
    
    return data || []
  } catch (error) {
    console.error('❌ Error in getEnabledStrategies:', error)
    return []
  }
}

/**
 * Check if a token passes the filters for a given strategy
 */
export function tokenPassesFilters(token: TokenData, filters: TokenFilters): boolean {
  // Market cap check
  if (token.market_cap < filters.min_market_cap || token.market_cap > filters.max_market_cap) {
    return false
  }
  
  // Volume check
  if (token.volume_1h < filters.min_volume_1h) {
    return false
  }
  
  // Price change checks
  if (token.price_change_5m < filters.min_price_change_5m || token.price_change_5m > filters.max_price_change_5m) {
    return false
  }
  
  // Organic score check
  if (token.organic_score < filters.min_organic_score) {
    return false
  }
  
  // Excluded tokens check
  if (filters.excluded_tokens?.includes(token.address)) {
    return false
  }
  
  // Excluded symbols check
  if (filters.excluded_symbols?.includes(token.symbol)) {
    return false
  }
  
  return true
}

/**
 * Calculate a confidence score for how well a token matches a strategy
 */
export function calculateStrategyConfidence(token: TokenData, strategy: TradingStrategy): number {
  let confidence = 0
  
  // Base confidence if token passes filters
  if (!tokenPassesFilters(token, strategy.token_filters)) {
    return 0
  }
  
  confidence += 30 // Base score for passing filters
  
  // Strategy type specific scoring
  const strategyType = strategy.config?.strategy_type || 'conservative'
  
  switch (strategyType) {
    case 'aggressive':
      // Favor high volatility and momentum
      if (token.price_change_5m > 50) confidence += 20
      if (token.price_change_1h > 100) confidence += 15
      if (token.net_buyers_1h > 2000) confidence += 10
      if (token.volume_1h > 50000) confidence += 10
      break
      
    case 'conservative':
      // Favor stable growth and good fundamentals
      if (token.price_change_5m > 10 && token.price_change_5m < 100) confidence += 20
      if (token.organic_score > 80) confidence += 15
      if (token.market_cap > 500000 && token.market_cap < 1000000) confidence += 10
      if (token.net_buyers_1h > 1000 && token.net_buyers_1h < 3000) confidence += 10
      break
      
    case 'scalping':
      // Favor high volume and quick movements
      if (token.volume_1h > 100000) confidence += 20
      if (token.price_change_5m > 20 && token.price_change_5m < 200) confidence += 15
      if (token.net_buyers_1h > 1500) confidence += 10
      break
      
    case 'swing':
      // Favor medium-term trends
      if (token.price_change_1h > 50 && token.price_change_1h < 300) confidence += 20
      if (token.organic_score > 75) confidence += 15
      if (token.market_cap > 400000) confidence += 10
      break
      
    case 'momentum':
      // Favor strong momentum indicators
      if (token.price_change_1h > 150) confidence += 25
      if (token.net_buyers_1h > 2500) confidence += 15
      if (token.volume_1h > 75000) confidence += 10
      break
      
    default:
      // Default scoring
      if (token.price_change_5m > 20) confidence += 10
      if (token.organic_score > 70) confidence += 10
      break
  }
  
  // Performance-based adjustment
  const performance = strategy.performance
  if (performance.total_trades > 10) {
    if (performance.win_rate > 0.6) {
      confidence += 15 // Boost for good performing strategies
    } else if (performance.win_rate < 0.4) {
      confidence -= 10 // Penalty for poor performing strategies
    }
  }
  
  // Risk management consideration
  const riskLevel = strategy.risk_management?.max_position_size_sol || 0.1
  if (riskLevel > 0.5) {
    confidence -= 5 // Slight penalty for high risk
  }
  
  return Math.min(100, Math.max(0, confidence))
}

/**
 * Select the best strategy for a given token
 */
export async function selectStrategyForToken(token: TokenData): Promise<StrategySelection | null> {
  try {
    const strategies = await getEnabledStrategies()
    
    if (strategies.length === 0) {
      console.log('⚠️ No enabled strategies found')
      return null
    }
    
    // Calculate confidence for each strategy
    const strategyScores = strategies.map(strategy => ({
      strategy,
      confidence: calculateStrategyConfidence(token, strategy),
      reason: `Strategy type: ${strategy.config?.strategy_type || 'unknown'}, Win rate: ${(strategy.performance.win_rate * 100).toFixed(1)}%`
    }))
    
    // Filter out strategies with zero confidence
    const validStrategies = strategyScores.filter(s => s.confidence > 0)
    
    if (validStrategies.length === 0) {
      console.log(`⚠️ No strategies match token ${token.symbol} (${token.address})`)
      return null
    }
    
    // Sort by confidence and return the best match
    validStrategies.sort((a, b) => b.confidence - a.confidence)
    
    const bestStrategy = validStrategies[0]
    
    console.log(`✅ Selected strategy "${bestStrategy.strategy.name}" for ${token.symbol} (confidence: ${bestStrategy.confidence}%)`)
    
    return bestStrategy
    
  } catch (error) {
    console.error('❌ Error selecting strategy for token:', error)
    return null
  }
}

/**
 * Get strategy distribution for load balancing
 */
export async function getStrategyDistribution(): Promise<Record<string, number>> {
  try {
    const { data, error } = await supabase
      .from(TRACKED_TOKENS_TABLE)
      .select('strategy_id')
      .eq('status', 'tracking')
    
    if (error) {
      console.error('❌ Error fetching strategy distribution:', error)
      return {}
    }
    
    const distribution: Record<string, number> = {}
    
    data?.forEach(token => {
      if (token.strategy_id) {
        distribution[token.strategy_id] = (distribution[token.strategy_id] || 0) + 1
      }
    })
    
    return distribution
    
  } catch (error) {
    console.error('❌ Error in getStrategyDistribution:', error)
    return {}
  }
}

/**
 * Apply load balancing to strategy selection
 */
export async function selectStrategyWithLoadBalancing(token: TokenData): Promise<StrategySelection | null> {
  try {
    const strategies = await getEnabledStrategies()
    const distribution = await getStrategyDistribution()
    
    if (strategies.length === 0) {
      return null
    }
    
    // Calculate confidence for each strategy
    const strategyScores = strategies.map(strategy => {
      const baseConfidence = calculateStrategyConfidence(token, strategy)
      
      if (baseConfidence === 0) {
        return { strategy, confidence: 0, reason: 'Token does not match strategy filters' }
      }
      
      // Apply load balancing penalty
      const currentLoad = distribution[strategy.id] || 0
      const totalTracking = Object.values(distribution).reduce((sum, count) => sum + count, 0)
      const expectedLoad = totalTracking / strategies.length
      
      let loadBalancingAdjustment = 0
      if (currentLoad > expectedLoad * 1.5) {
        loadBalancingAdjustment = -15 // Penalty for overloaded strategies
      } else if (currentLoad < expectedLoad * 0.5) {
        loadBalancingAdjustment = 10 // Bonus for underutilized strategies
      }
      
      const finalConfidence = Math.max(0, baseConfidence + loadBalancingAdjustment)
      
      return {
        strategy,
        confidence: finalConfidence,
        reason: `Base: ${baseConfidence}%, Load adjustment: ${loadBalancingAdjustment}%, Current load: ${currentLoad}`
      }
    })
    
    // Filter and sort
    const validStrategies = strategyScores.filter(s => s.confidence > 0)
    
    if (validStrategies.length === 0) {
      return null
    }
    
    validStrategies.sort((a, b) => b.confidence - a.confidence)
    
    return validStrategies[0]
    
  } catch (error) {
    console.error('❌ Error in selectStrategyWithLoadBalancing:', error)
    return await selectStrategyForToken(token) // Fallback to basic selection
  }
}

/**
 * Convert strategy configuration to legacy TradingSimulation format
 */
export function strategyToTradingSimulation(strategy: TradingStrategy): any {
  const config = strategy.config || {}
  const riskMgmt = strategy.risk_management || {}
  
  return {
    take_profit_levels: {
      tp1_percentage: config.tp1_percentage || 60,
      tp1_sell_percentage: config.tp1_sell_percentage || 80,
      tp2_percentage: config.tp2_percentage || 100,
      tp2_sell_percentage: config.tp2_sell_percentage || 100,
      tp3_percentage: config.tp3_percentage || 150,
      tp3_sell_percentage: config.tp3_sell_percentage || 100,
      tp3_enabled: config.tp3_enabled || false
    },
    stop_loss_percentage: riskMgmt.stop_loss_percentage || -50,
    max_hold_hours: riskMgmt.max_hold_hours || 24,
    position_size_sol: riskMgmt.max_position_size_sol || 0.1,
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    strategy_type: config.strategy_type || 'conservative'
  }
}