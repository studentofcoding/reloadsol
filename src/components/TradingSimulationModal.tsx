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
  isSimulated: boolean
  keypairPath: string
  onTradeTriggered?: (type: string, details: any) => Promise<void>
}

export default function TradingSimulationModal({
  isOpen,
  onClose,
  tokenAddress,
  tokenSymbol,
  tokenName,
  logoUrl,
  isSimulated,
  keypairPath,
  onTradeTriggered
}: TradingSimulationModalProps) {
  const [simulationData, setSimulationData] = useState<TradingSimulationData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const lastNotifiedStatusRef = React.useRef<string | null>(null)

  useEffect(() => {
    if (isOpen && tokenAddress) {
      fetchSimulationData()
    }
  }, [isOpen, tokenAddress])

  const fetchSimulationData = async () => {
    try {
      setLoading(true)
      setError('')
      
      const response = await fetch(`/api/trending/track?token=${tokenAddress}&isSimulated=${isSimulated}&keypairPath=${encodeURIComponent(keypairPath)}`)
      
      if (!response.ok) {
        throw new Error(`Failed to fetch simulation data: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.success && data.token.trading_simulation) {
        setSimulationData(data.token.trading_simulation)
        
        // Notify on trade triggers if callback provided and status has changed
        const newStatus = data.token.trading_simulation.current_status
        if (onTradeTriggered && 
            newStatus !== lastNotifiedStatusRef.current && 
            newStatus !== simulationData?.current_status) {
          
          // Get the most recent operation details
          const latestOperation = data.token.trading_simulation.sell_operations?.length > 0 
            ? data.token.trading_simulation.sell_operations[data.token.trading_simulation.sell_operations.length - 1]
            : data.token.trading_simulation.buy_operation

          // Get the best configuration from the operation
          const bestConfig = latestOperation?.best_config || {}
          
          const details = {
            currentGain: data.token.current_gain_percentage,
            peakGain: data.token.peak_gain_percentage,
            price: data.token.last_price_usd,
            status: newStatus,
            // Add provider, RPC, and timing information
            provider: bestConfig.provider || latestOperation?.configurations?.best?.provider,
            rpc: bestConfig.rpc_used || latestOperation?.configurations?.best?.rpc_used,
            responseTime: bestConfig.response_time || latestOperation?.configurations?.best?.response_time,
          }
          await onTradeTriggered(newStatus, details)
          lastNotifiedStatusRef.current = newStatus
        }
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

  // Reset last notified status when modal closes
  useEffect(() => {
    if (!isOpen) {
      lastNotifiedStatusRef.current = null
    }
  }, [isOpen])

  const formatNumber = (num: number, decimals: number = 6) => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(num)
  }

  const formatTokenAmount = (amount: string) => {
    const num = parseFloat(amount)/1000000
    if (num === 0) return '0'
    if (num < 0.000001) return '< 0.000001'
    return formatNumber(num, 6)
  }

  const formatSolAmount = (amount: string) => {
    const num = parseFloat(amount)/1000000000
    if (num === 0) return '0'
    if (num < 0.000001) return '< 0.000001'
    return formatNumber(num, 6)
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-400'
      case 'holding': return 'text-blue-400'
      case 'buying': return 'text-yellow-400'
      case 'selling': return 'text-orange-400'
      case 'failed': return 'text-red-400'
      default: return 'text-gray-400'
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
    return gain >= 0 ? 'text-green-400' : 'text-red-400'
  }

  const calculateGainPercentage = (sellPrice: number, buyPrice: number): number => {
    if (!buyPrice || buyPrice === 0) return 0
    return ((sellPrice - buyPrice) / buyPrice) * 100
  }

  const calculateSolGain = (soldAmount: string, boughtAmount: number): number => {
    const soldSol = parseFloat(soldAmount) / 1000000000 // Convert from lamports to SOL
    return soldSol - boughtAmount
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg max-w-6xl w-full max-h-[90vh] overflow-y-auto border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
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
              <h2 className="text-xl font-bold text-white">
                {isSimulated ? 'Trading Simulation' : 'Live Trading'}: {tokenSymbol || 'Unknown Token'}
              </h2>
              <p className="text-sm text-gray-400">
                {tokenName || tokenAddress}
              </p>
              {!isSimulated && (
                <p className="text-xs text-green-400 mt-1">
                  🚀 Live Trading Mode
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl transition-colors"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading && (
            <div className="flex items-center justify-center py-8 text-gray-300">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400"></div>
              <span className="ml-2">Loading trading simulation data...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-900/20 border border-red-600/30 rounded-lg p-4 mb-6">
              <p className="text-red-400">{error}</p>
            </div>
          )}

          {simulationData && (
            <div className="space-y-6">
              {/* Simulation Status */}
              <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-semibold text-white">Simulation Status</h3>
                  <span className={`font-semibold ${getStatusColor(simulationData.current_status)}`}>
                    {getStatusIcon(simulationData.current_status)} {simulationData.current_status.toUpperCase()}
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-gray-400">Started</p>
                    <p className="font-medium text-white">{new Date(simulationData.simulation_started_at).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-gray-400">Target Gain</p>
                    <p className="font-medium text-green-400">+{simulationData.target_gain_percentage}%</p>
                  </div>
                  <div>
                    <p className="text-gray-400">Stop Loss</p>
                    <p className="font-medium text-red-400">{simulationData.stop_loss_percentage}%</p>
                  </div>
                  <div>
                    <p className="text-gray-400">Max Hold</p>
                    <p className="font-medium text-white">{simulationData.max_hold_hours}h</p>
                  </div>
                </div>
              </div>

              {/* Final Results (if completed) */}
              {simulationData.final_result && (
                <div className="bg-green-900/20 border border-green-600/30 rounded-lg p-4">
                  <h3 className="text-lg font-semibold text-green-400 mb-3">🎯 Final Results</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-sm text-green-400/80">Total Gain</p>
                      <p className={`font-semibold text-lg ${getGainColor(calculateGainPercentage(
                        simulationData.final_result.sell_price_usd,
                        simulationData.final_result.buy_price_usd
                      ))}`}>
                        {calculateGainPercentage(
                          simulationData.final_result.sell_price_usd,
                          simulationData.final_result.buy_price_usd
                        ).toFixed(2)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-green-400/80">SOL Gained</p>
                      <p className={`font-semibold text-lg ${getGainColor(
                        simulationData.sell_operation ? 
                        calculateSolGain(
                          simulationData.sell_operation.sol_received,
                          simulationData.buy_operation?.buy_amount_sol || 0
                        ) : 0
                      )}`}>
                        {simulationData.sell_operation ? 
                          formatNumber(calculateSolGain(
                            simulationData.sell_operation.sol_received,
                            simulationData.buy_operation?.buy_amount_sol || 0
                          ), 6) : '0'} SOL
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-green-400/80">Hold Duration</p>
                      <p className="font-semibold text-lg text-white">{simulationData.final_result.hold_duration_hours.toFixed(1)}h</p>
                    </div>
                    <div>
                      <p className="text-sm text-green-400/80">Buy → Sell Price</p>
                      <p className="font-semibold text-lg text-white">${simulationData.final_result.buy_price_usd.toFixed(6)} → ${simulationData.final_result.sell_price_usd.toFixed(6)}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Buy Operation */}
              {simulationData.buy_operation && (
                <div className="border border-gray-700 rounded-lg p-4 bg-gray-800/30">
                  <h3 className="text-lg font-semibold mb-4 text-white">💰 Buy Operation</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div>
                      <p className="text-sm text-gray-400">Buy Amount</p>
                      <p className="font-medium text-white">{simulationData.buy_operation.buy_amount_sol} SOL</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">Tokens Received</p>
                      <p className="font-medium text-white">{formatTokenAmount(simulationData.buy_operation.token_amount_received)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">Buy Price</p>
                      <p className="font-medium text-white">${simulationData.buy_operation.buy_price_usd.toFixed(6)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">Best Config</p>
                      <p className="font-medium text-white">{simulationData.buy_operation.best_buy_config.provider} ({simulationData.buy_operation.best_buy_config.slippage}%)</p>
                    </div>
                  </div>
                  
                  <h4 className="font-semibold mb-2 text-gray-300">Buy Configurations Tested</h4>
                  <div className="grid gap-3">
                    {Object.entries(simulationData.buy_operation.configurations).map(([key, config]) => (
                      <div key={key} className="border border-gray-700 rounded p-3 bg-gray-800/50">
                        <div className="flex items-center justify-between mb-2">
                          <h5 className="font-medium capitalize text-gray-300">
                            {key.replace('_', ' ')} ({key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%'} slippage)
                          </h5>
                          <span className={`text-sm ${config.success ? 'text-green-400' : 'text-red-400'}`}>
                            {config.success ? '✅ Success' : '❌ Failed'}
                          </span>
                        </div>
                        {config.success ? (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                            <div>
                              <span className="text-gray-400">Provider:</span>
                              <span className="ml-1 font-medium text-white capitalize">{config.best_provider}</span>
                            </div>
                            <div>
                              <span className="text-gray-400">Tokens:</span>
                              <span className="ml-1 font-medium text-white">{formatTokenAmount(config.token_amount)}</span>
                            </div>
                            <div>
                              <span className="text-gray-400">Time:</span>
                              <span className="ml-1 font-medium text-white">{config.response_time}ms</span>
                            </div>
                            <div>
                              <span className="text-gray-400">Fees:</span>
                              <span className="ml-1 font-medium text-white">{formatNumber(config.total_fees, 6)} SOL</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-red-400 text-sm">
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
                <div className="border border-gray-700 rounded-lg p-4 bg-gray-800/30">
                  <h3 className="text-lg font-semibold mb-4 text-white">💸 Sell Operation</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div>
                      <p className="text-sm text-gray-400">Tokens Sold</p>
                      <p className="font-medium text-white">{formatTokenAmount(simulationData.sell_operation.sell_amount_tokens)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">SOL Received</p>
                      <p className="font-medium text-white">{formatSolAmount(simulationData.sell_operation.sol_received)} SOL</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">Sell Price</p>
                      <p className="font-medium text-white">${simulationData.sell_operation.sell_price_usd.toFixed(6)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-400">Final Gain</p>
                      <p className={`font-medium ${getGainColor(calculateGainPercentage(
                        simulationData.sell_operation.sell_price_usd,
                        simulationData.buy_operation?.buy_price_usd || 0
                      ))}`}>
                        {calculateGainPercentage(
                          simulationData.sell_operation.sell_price_usd,
                          simulationData.buy_operation?.buy_price_usd || 0
                        ).toFixed(2)}%
                      </p>
                    </div>
                  </div>
                  
                  <h4 className="font-semibold mb-2 text-gray-300">Sell Configurations Tested</h4>
                  <div className="grid gap-3">
                    {Object.entries(simulationData.sell_operation.configurations).map(([key, config]) => (
                      <div key={key} className="border border-gray-700 rounded p-3 bg-gray-800/50">
                        <div className="flex items-center justify-between mb-2">
                          <h5 className="font-medium capitalize text-gray-300">
                            {key.replace('_', ' ')} ({key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%'} slippage)
                          </h5>
                          <span className={`text-sm ${config.success ? 'text-green-400' : 'text-red-400'}`}>
                            {config.success ? '✅ Success' : '❌ Failed'}
                          </span>
                        </div>
                        {config.success ? (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                            <div>
                              <span className="text-gray-400">Provider:</span>
                              <span className="ml-1 font-medium text-white capitalize">{config.best_provider}</span>
                            </div>
                            <div>
                              <span className="text-gray-400">SOL:</span>
                              <span className="ml-1 font-medium text-white">{formatNumber(parseFloat(config.sol_amount)/1000000000, 6)}</span>
                            </div>
                            <div>
                              <span className="text-gray-400">Time:</span>
                              <span className="ml-1 font-medium text-white">{config.response_time}ms</span>
                            </div>
                            <div>
                              <span className="text-gray-400">Fees:</span>
                              <span className="ml-1 font-medium text-white">{formatNumber(config.total_fees, 6)} SOL</span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-red-400 text-sm">
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
                <div className="bg-yellow-900/20 border border-yellow-600/30 rounded-lg p-4 text-center">
                  <p className="text-yellow-400">No trading simulation data available for this token</p>
                  <p className="text-yellow-400/80 text-sm mt-1">The token may not have been processed for simulation yet</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-6 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
} 