import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'
import {
  TradingStrategy,
  CreateStrategyRequest,
  STRATEGY_TEMPLATES
} from '@/types/trading-strategies'

export const runtime = 'edge'

// Table names
const STRATEGIES_TABLE = process.env.NODE_ENV === 'development' ? 'trading_strategies_dev' : 'trading_strategies'

// GET - Get all available strategy templates
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const templateType = searchParams.get('type')
    
    let templates = STRATEGY_TEMPLATES
    
    // Filter by type if specified
    if (templateType) {
      templates = Object.fromEntries(
        Object.entries(STRATEGY_TEMPLATES).filter(([key, template]) => 
          template.config?.strategy_type === templateType
        )
      )
    }
    
    // Add default token filters and trading params to templates
    const enrichedTemplates = Object.fromEntries(
      Object.entries(templates).map(([key, template]) => [
        key,
        {
          ...template,
          token_filters: template.token_filters || {
            min_market_cap: 300_000,
            max_market_cap: 2_000_000,
            min_volume_1h: 10_000,
            min_price_change_5m: -40,
            max_price_change_5m: 500,
            min_organic_score: 65,
            excluded_tokens: [],
            excluded_symbols: []
          },
          trading_params: template.trading_params || {
            entry_strategy: 'immediate',
            entry_conditions: {
              dip_percentage: 15,
              momentum_threshold: 120
            },
            exit_strategy: 'take_profit_stop_loss',
            exit_conditions: {
              time_based_exit_hours: 24
            },
            slippage_tolerance_bps: 300,
            priority_fee_sol: 0.001,
            retry_attempts: 3,
            retry_delay_ms: 1000
          }
        }
      ])
    )
    
    return NextResponse.json({
      success: true,
      templates: enrichedTemplates,
      available_types: ['conservative', 'aggressive', 'scalping', 'swing', 'momentum', 'custom']
    })
    
  } catch (error) {
    console.error('❌ Error fetching strategy templates:', error)
    return NextResponse.json(
      { error: 'Failed to fetch strategy templates', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// POST - Create strategy from template
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { template_key, customizations = {}, name_suffix = '' } = body
    
    if (!template_key || !STRATEGY_TEMPLATES[template_key]) {
      return NextResponse.json(
        { error: 'Invalid or missing template_key' },
        { status: 400 }
      )
    }
    
    const template = STRATEGY_TEMPLATES[template_key]
    
    // Create strategy from template with customizations
    const strategy: CreateStrategyRequest = {
      name: `${template.name}${name_suffix ? ` - ${name_suffix}` : ''}`,
      description: customizations.description || template.description || '',
      config: {
        ...template.config!,
        ...customizations.config
      },
      risk_management: {
        ...template.risk_management!,
        ...customizations.risk_management
      },
      token_filters: {
        min_market_cap: 300_000,
        max_market_cap: 2_000_000,
        min_volume_1h: 10_000,
        min_price_change_5m: -40,
        max_price_change_5m: 500,
        min_organic_score: 65,
        excluded_tokens: [],
        excluded_symbols: [],
        ...customizations.token_filters
      },
      trading_params: {
        entry_strategy: 'immediate',
        entry_conditions: {
          dip_percentage: 15,
          momentum_threshold: 120
        },
        exit_strategy: 'take_profit_stop_loss',
        exit_conditions: {
          time_based_exit_hours: 24
        },
        slippage_tolerance_bps: 300,
        priority_fee_sol: 0.001,
        retry_attempts: 3,
        retry_delay_ms: 1000,
        ...customizations.trading_params
      }
    }
    
    // Create the strategy
    const strategyRecord: Omit<TradingStrategy, 'id'> = {
      name: strategy.name,
      description: strategy.description,
      enabled: false, // New strategies start disabled
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      config: strategy.config,
      performance: {
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        win_rate: 0,
        total_pnl_sol: 0,
        total_pnl_percentage: 0,
        average_gain_percentage: 0,
        average_loss_percentage: 0,
        max_gain_percentage: 0,
        max_loss_percentage: 0,
        max_drawdown_percentage: 0,
        daily_pnl: {},
        hourly_performance: {},
        last_updated: new Date().toISOString()
      },
      risk_management: strategy.risk_management,
      token_filters: strategy.token_filters,
      trading_params: strategy.trading_params
    }
    
    // Insert into database
    const { data, error } = await supabase
      .from(STRATEGIES_TABLE)
      .insert(strategyRecord)
      .select()
      .single()
    
    if (error) {
      throw new Error(`Failed to create strategy from template: ${error.message}`)
    }
    
    return NextResponse.json({
      success: true,
      strategy: data,
      template_used: template_key,
      message: `Strategy created from ${template_key} template`
    })
    
  } catch (error) {
    console.error('❌ Error creating strategy from template:', error)
    return NextResponse.json(
      { error: 'Failed to create strategy from template', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// PUT - Update template (for custom templates)
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { template_key, template_data } = body
    
    if (!template_key || !template_data) {
      return NextResponse.json(
        { error: 'Missing required fields: template_key, template_data' },
        { status: 400 }
      )
    }
    
    // For now, we'll store custom templates in the database
    // In a production environment, you might want to use a separate table for custom templates
    
    const customTemplate: Omit<TradingStrategy, 'id'> = {
      name: `Template: ${template_data.name}`,
      description: `Custom template: ${template_data.description}`,
      enabled: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      config: {
        strategy_type: 'custom',
        ...template_data.config
      },
      performance: {
        total_trades: 0,
        winning_trades: 0,
        losing_trades: 0,
        win_rate: 0,
        total_pnl_sol: 0,
        total_pnl_percentage: 0,
        average_gain_percentage: 0,
        average_loss_percentage: 0,
        max_gain_percentage: 0,
        max_loss_percentage: 0,
        max_drawdown_percentage: 0,
        daily_pnl: {},
        hourly_performance: {},
        last_updated: new Date().toISOString()
      },
      risk_management: template_data.risk_management,
      token_filters: template_data.token_filters,
      trading_params: template_data.trading_params
    }
    
    // Check if template already exists
    const { data: existingTemplate } = await supabase
      .from(STRATEGIES_TABLE)
      .select('id')
      .eq('name', customTemplate.name)
      .single()
    
    let result
    if (existingTemplate) {
      // Update existing template
      const { data, error } = await supabase
        .from(STRATEGIES_TABLE)
        .update({
          ...customTemplate,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingTemplate.id)
        .select()
        .single()
      
      if (error) {
        throw new Error(`Failed to update custom template: ${error.message}`)
      }
      result = data
    } else {
      // Create new template
      const { data, error } = await supabase
        .from(STRATEGIES_TABLE)
        .insert(customTemplate)
        .select()
        .single()
      
      if (error) {
        throw new Error(`Failed to create custom template: ${error.message}`)
      }
      result = data
    }
    
    return NextResponse.json({
      success: true,
      template: result,
      message: `Custom template ${existingTemplate ? 'updated' : 'created'} successfully`
    })
    
  } catch (error) {
    console.error('❌ Error saving custom template:', error)
    return NextResponse.json(
      { error: 'Failed to save custom template', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}