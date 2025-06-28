'use client'

import React, { useState, useEffect } from 'react'

interface TradingSimulationData {
  token_address: string
  token_symbol: string | null
  simulation_started_at: string
  buy_operation: {
    timestamp: string
    buy_amount_sol: number
    token_amount_received: string
    buy_price_usd: number
    configurations: {
      slippage_1: BuyConfigResult
      slippage_2: BuyConfigResult
      slippage_5: BuyConfigResult
    }
    best_buy_config: {
      slippage: number
      provider: string
      token_amount: string
      response_time: number
      total_fees: number
      rpc_used: string
    }
    rpc_used: string
  } | null
  sell_operation: {
    timestamp: string
    sell_amount_tokens: string
    sol_received: string
    sell_price_usd: number
    configurations: {
      slippage_1: SellConfigResult
      slippage_2: SellConfigResult
      slippage_5: SellConfigResult
    }
    best_sell_config: {
      slippage: number
      provider: string
      sol_amount: string
      response_time: number
      total_fees: number
      rpc_used: string
    }
    rpc_used: string
    final_gain_percentage: number
    hold_duration_hours: number
  } | null
  current_status: 'buying' | 'holding' | 'selling' | 'completed' | 'failed'
  target_gain_percentage: number
  stop_loss_percentage: number
  max_hold_hours: number
  final_result: {
    success: boolean
    total_gain_percentage: number
    total_gain_sol: number
    buy_price_usd: number
    sell_price_usd: number
    hold_duration_hours: number
    best_buy_config: any
    best_sell_config: any
  } | null
}

interface BuyConfigResult {
  success: boolean
  response_time: number
  token_amount: string
  total_fees: number
  price_impact: string
  best_provider: string
  rpc_used?: string
  error?: string
}

interface SellConfigResult {
  success: boolean
  response_time: number
  sol_amount: string
  total_fees: number
  price_impact: string
  best_provider: string
  rpc_used?: string
  error?: string
}

interface TradingSimulationModalProps {
  isOpen: boolean
  onClose: () => void
  tokenAddress: string
  tokenSymbol: string | null
  tokenName: string | null
  logoUrl: string | null
}

export default function TradingSimulationModal({
  isOpen,
  onClose,
  tokenAddress,
  tokenSymbol,
  tokenName,
  logoUrl
}: TradingSimulationModalProps) {
  const [simulationData, setSimulationData] = useState<TradingSimulationData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    if (isOpen && tokenAddress) {
      fetchSimulationData()
    }
  }, [isOpen, tokenAddress])

  const fetchSimulationData = async () => {
    try {
      setLoading(true)
      setError('')
      
      const response = await fetch(`/api/trending/track?token=${tokenAddress}`)
      
      if (!response.ok) {
        throw new Error(`Failed to fetch simulation data: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.success && data.token.trading_simulation) {
        setSimulationData(data.token.trading_simulation)
      } else {
        setError('No trading simulation data available for this token')
      }
    } catch (error) {
      console.error('Error fetching simulation data:', error)
      setError(error instanceof Error ? error.message : 'Failed to fetch simulation data')
    } finally {
      setLoading(false)
    }
  }

  const formatNumber = (num: number, decimals: number = 6) => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(num)
  }

  const formatTokenAmount = (amount: string) => {
    const num = parseFloat(amount)
    if (num === 0) return '0'
    if (num < 0.000001) return '< 0.000001'
    return formatNumber(num, 6)
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-600'
      case 'holding': return 'text-blue-600'
      case 'buying': return 'text-yellow-600'
      case 'selling': return 'text-orange-600'
      case 'failed': return 'text-red-600'
      default: return 'text-gray-600'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return '✅'
      case 'holding': return '⏳'
      case 'buying': return '💰'
      case 'selling': return '💸'
      case 'failed': return '❌'
      default: return '❓'
    }
  }

  const getGainColor = (gain: number) => {
    return gain >= 0 ? 'text-green-600' : 'text-red-600'
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center space-x-3">
            {logoUrl && (
              <img 
                src={logoUrl} 
                alt={tokenSymbol || 'Token'} 
                className="w-8 h-8 rounded-full"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            )}
            <div>
              <h2 className="text-xl font-bold">
                Trading Simulation: {tokenSymbol || 'Unknown Token'}
              </h2>
              <p className="text-sm text-gray-600">
                {tokenName || tokenAddress}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <span className="ml-2">Loading trading simulation data...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p className="text-red-600">{error}</p>
            </div>
          )}

          {simulationData && (
            <div className="space-y-6">
              {/* Simulation Status */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-semibold">Simulation Status</h3>
                  <span className={`font-semibold ${getStatusColor(simulationData.current_status)}`}>
                    {getStatusIcon(simulationData.current_status)} {simulationData.current_status.toUpperCase()}
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-gray-600">Started</p>
                    <p className="font-medium">{new Date(simulationData.simulation_started_at).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Target Gain</p>
                    <p className="font-medium text-green-600">+{simulationData.target_gain_percentage}%</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Stop Loss</p>
                    <p className="font-medium text-red-600">{simulationData.stop_loss_percentage}%</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Max Hold</p>
                    <p className="font-medium">{simulationData.max_hold_hours}h</p>
                  </div>
                </div>
              </div>

              {/* Final Results (if completed) */}
              {simulationData.final_result && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <h3 className="text-lg font-semibold text-green-900 mb-3">🎯 Final Results</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-sm text-green-700">Total Gain</p>
                      <p className={`font-semibold text-lg ${getGainColor(simulationData.final_result.total_gain_percentage)}`}>
                        {simulationData.final_result.total_gain_percentage >= 0 ? '+' : ''}{simulationData.final_result.total_gain_percentage.toFixed(2)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-green-700">SOL Gained</p>
                      <p className={`font-semibold text-lg ${getGainColor(simulationData.final_result.total_gain_sol)}`}>
                        {simulationData.final_result.total_gain_sol >= 0 ? '+' : ''}{formatNumber(simulationData.final_result.total_gain_sol, 6)} SOL
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-green-700">Hold Duration</p>
                      <p className="font-semibold text-lg">{simulationData.final_result.hold_duration_hours.toFixed(1)}h</p>
                    </div>
                    <div>
                      <p className="text-sm text-green-700">Buy → Sell Price</p>
                      <p className="font-semibold text-lg">${simulationData.final_result.buy_price_usd.toFixed(6)} → ${simulationData.final_result.sell_price_usd.toFixed(6)}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Buy Operation */}
              {simulationData.buy_operation && (
                <div className="border rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-4">💰 Buy Operation</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div>
                      <p className="text-sm text-gray-600">Buy Amount</p>
                      <p className="font-medium">{simulationData.buy_operation.buy_amount_sol} SOL</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Tokens Received</p>
                      <p className="font-medium">{formatTokenAmount(simulationData.buy_operation.token_amount_received)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Buy Price</p>
                      <p className="font-medium">${simulationData.buy_operation.buy_price_usd.toFixed(6)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Best Config</p>
                      <p className="font-medium">{simulationData.buy_operation.best_buy_config.provider} ({simulationData.buy_operation.best_buy_config.slippage}%)</p>
                    </div>
                  </div>
                  
                  <h4 className="font-semibold mb-2">Buy Configurations Tested</h4>
                  <div className="grid gap-3">
                    {Object.entries(simulationData.buy_operation.configurations).map(([key, config]) => (
                      <div key={key} className="border rounded p-3">
                        <div className="flex items-center justify-between mb-2">
                          <h5 className="font-medium capitalize">
                            {key.replace('_', ' ')} ({key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%'} slippage)
                          </h5>
                          <span className={`text-sm ${config.success ? 'text-green-600' : 'text-red-600'}`}>
                            {config.success ? '✅ Success' : '❌ Failed'}
                          </span>
                        </div>
                        {config.success ? (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                            <div>
                              <span className="text-gray-600">Provider:</span>
                              <span className="ml-1 font-medium capitalize">{config.best_provider}</span>
                            </div>
                            <div>
                              <span className="text-gray-600">Tokens:</span>
                              <span className="ml-1 font-medium">{formatTokenAmount(config.token_amount)}</span>
                            </div>
                            <div>
                              <span className="text-gray-600">Time:</span>
                              <span className="ml-1 font-medium">{config.response_time}ms</span>
                            </div>
                            <div>
                              <span className="text-gray-600">Fees:</span>
                              <span className="ml-1 font-medium">{formatNumber(config.total_fees, 6)} SOL</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-red-600 text-sm">
                            Error: {config.error || 'Unknown error'}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sell Operation */}
              {simulationData.sell_operation && (
                <div className="border rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-4">💸 Sell Operation</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div>
                      <p className="text-sm text-gray-600">Tokens Sold</p>
                      <p className="font-medium">{formatTokenAmount(simulationData.sell_operation.sell_amount_tokens)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">SOL Received</p>
                      <p className="font-medium">{formatNumber(parseFloat(simulationData.sell_operation.sol_received), 6)} SOL</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Sell Price</p>
                      <p className="font-medium">${simulationData.sell_operation.sell_price_usd.toFixed(6)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Final Gain</p>
                      <p className={`font-medium ${getGainColor(simulationData.sell_operation.final_gain_percentage)}`}>
                        {simulationData.sell_operation.final_gain_percentage >= 0 ? '+' : ''}{simulationData.sell_operation.final_gain_percentage.toFixed(2)}%
                      </p>
                    </div>
                  </div>
                  
                  <h4 className="font-semibold mb-2">Sell Configurations Tested</h4>
                  <div className="grid gap-3">
                    {Object.entries(simulationData.sell_operation.configurations).map(([key, config]) => (
                      <div key={key} className="border rounded p-3">
                        <div className="flex items-center justify-between mb-2">
                          <h5 className="font-medium capitalize">
                            {key.replace('_', ' ')} ({key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%'} slippage)
                          </h5>
                          <span className={`text-sm ${config.success ? 'text-green-600' : 'text-red-600'}`}>
                            {config.success ? '✅ Success' : '❌ Failed'}
                          </span>
                        </div>
                        {config.success ? (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                            <div>
                              <span className="text-gray-600">Provider:</span>
                              <span className="ml-1 font-medium capitalize">{config.best_provider}</span>
                            </div>
                            <div>
                              <span className="text-gray-600">SOL:</span>
                              <span className="ml-1 font-medium">{formatNumber(parseFloat(config.sol_amount), 6)}</span>
                            </div>
                            <div>
                              <span className="text-gray-600">Time:</span>
                              <span className="ml-1 font-medium">{config.response_time}ms</span>
                            </div>
                            <div>
                              <span className="text-gray-600">Fees:</span>
                              <span className="ml-1 font-medium">{formatNumber(config.total_fees, 6)} SOL</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-red-600 text-sm">
                            Error: {config.error || 'Unknown error'}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* No Simulation Data */}
              {!simulationData.buy_operation && !simulationData.sell_operation && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-center">
                  <p className="text-yellow-800">No trading simulation data available for this token</p>
                  <p className="text-yellow-600 text-sm mt-1">The token may not have been processed for simulation yet</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-6 border-t">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
} 