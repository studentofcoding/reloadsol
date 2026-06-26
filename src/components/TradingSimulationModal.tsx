'use client'

import { OptimizedImage } from "@/components/OptimizedImage";

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Line, Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  BarElement,
  Tooltip,
  Legend
} from 'chart.js'

import type { ChartData, ChartOptions, ChartDataset } from 'chart.js'

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, BarElement, Tooltip, Legend)

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

interface PriceRecord {
  timestamp: string
  price_usd: number
  volume: number | null
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
  const lastNotifiedStatusRef = React.useRef<string | null>(null)
  const [refreshId, setRefreshId] = useState(0)

  const {
    data: apiData,
    isFetching: loading,
    error: queryError,
  } = useQuery({
    queryKey: ['tradingSimulation', tokenAddress, refreshId],
    queryFn: async () => {
      const url = `/api/trending/track?token=${tokenAddress}&isSimulated=${isSimulated}&keypairPath=${encodeURIComponent(keypairPath)}&t=${Date.now()}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    enabled: isOpen && !!tokenAddress,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  })

  const error = queryError ? (queryError as Error).message : ''

  const priceHistory = useMemo<PriceRecord[]>(
    () => apiData?.token?.price_history ?? [],
    [apiData],
  )

  const simulationData = useMemo(
    () => apiData?.token?.trading_simulation ?? null,
    [apiData],
  )

  // Notify on trade status changes
  useEffect(() => {
    if (!apiData?.success || !apiData.token?.trading_simulation) return

    const newStatus = apiData.token.trading_simulation.current_status
    if (
      onTradeTriggered &&
      newStatus !== lastNotifiedStatusRef.current
    ) {
      const latestOperation =
        apiData.token.trading_simulation.sell_operation ??
        apiData.token.trading_simulation.buy_operation

      const bestConfig: any = latestOperation?.best_config || {}

      const details = {
        currentGain: apiData.token.current_gain_percentage,
        peakGain: apiData.token.peak_gain_percentage,
        price: apiData.token.last_price_usd,
        status: newStatus,
        provider: bestConfig.provider || (latestOperation as any)?.configurations?.best?.provider,
        rpc: bestConfig.rpc_used || (latestOperation as any)?.configurations?.best?.rpc_used,
        responseTime: bestConfig.response_time || (latestOperation as any)?.configurations?.best?.response_time,
      }
      onTradeTriggered(newStatus, details)
      lastNotifiedStatusRef.current = newStatus
    }
  }, [apiData, onTradeTriggered])

  const triggerRefresh = () => setRefreshId(id => id + 1)

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

  // ----- Helper functions for configuration analysis -----

  interface ConfigurationResult {
    type: string;
    slippage: string;
    time: number;
    provider: string;
  }

  const getFastestConfiguration = React.useCallback((simulationData: TradingSimulationData): ConfigurationResult | null => {
    let fastestConfig: ConfigurationResult | null = null;
    let fastestTime = Infinity;
    
    // Check buy configurations
    if (simulationData.buy_operation?.configurations) {
      Object.entries(simulationData.buy_operation.configurations).forEach(([key, config]) => {
        if (config.success && config.response_time < fastestTime) {
          fastestTime = config.response_time;
          const slippage = key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%';
          fastestConfig = { type: 'Buy', slippage, time: config.response_time, provider: config.best_provider };
        }
      });
    }
    
    // Check sell configurations
    if (simulationData.sell_operation?.configurations) {
      Object.entries(simulationData.sell_operation.configurations).forEach(([key, config]) => {
        if (config.success && config.response_time < fastestTime) {
          fastestTime = config.response_time;
          const slippage = key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%';
          fastestConfig = { type: 'Sell', slippage, time: config.response_time, provider: config.best_provider };
        }
      });
    }
    
    return fastestConfig;
  }, []);

  const getSuccessRate = React.useCallback((simulationData: TradingSimulationData) => {
    let successCount = 0;
    let totalCount = 0;
    
    if (simulationData.buy_operation?.configurations) {
      Object.values(simulationData.buy_operation.configurations).forEach(config => {
        totalCount++;
        if (config.success) successCount++;
      });
    }
    
    if (simulationData.sell_operation?.configurations) {
      Object.values(simulationData.sell_operation.configurations).forEach(config => {
        totalCount++;
        if (config.success) successCount++;
      });
    }
    
    return { successCount, totalCount, rate: totalCount > 0 ? (successCount / totalCount * 100) : 0 };
  }, []);

  const getAverageResponseTime = React.useCallback((simulationData: TradingSimulationData) => {
    let totalTime = 0;
    let successCount = 0;
    
    if (simulationData.buy_operation?.configurations) {
      Object.values(simulationData.buy_operation.configurations).forEach(config => {
        if (config.success) {
          totalTime += config.response_time;
          successCount++;
        }
      });
    }
    
    if (simulationData.sell_operation?.configurations) {
      Object.values(simulationData.sell_operation.configurations).forEach(config => {
        if (config.success) {
          totalTime += config.response_time;
          successCount++;
        }
      });
    }
    
    return { avgTime: successCount > 0 ? (totalTime / successCount) : 0, successCount };
  }, []);

  // ----- Memoised calculations for performance -----

  const priceStats = React.useMemo(() => {
    if (priceHistory.length === 0) return null

    const latestPrice = priceHistory[priceHistory.length - 1].price_usd
    const peakPrice = Math.max(...priceHistory.map((p) => p.price_usd))

    const avg =
      priceHistory.reduce((sum, p) => sum + p.price_usd, 0) / priceHistory.length
    const variance =
      priceHistory.reduce((sum, p) => sum + Math.pow(p.price_usd - avg, 2), 0) /
      priceHistory.length
    const volatility = Math.sqrt(variance)

    const totalVolume = priceHistory.reduce(
      (sum, p) => sum + (p.volume || 0),
      0
    )

    return { latestPrice, peakPrice, volatility, totalVolume }
  }, [priceHistory])

  const chartConfig = React.useMemo(
    () => getPriceHistoryChartConfig(priceHistory),
    [priceHistory],
  );

  const configPerformanceChart = React.useMemo(
    () =>
      simulationData
        ? getConfigurationPerformanceChartConfig(simulationData)
        : null,
    [simulationData],
  );

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <div className="flex items-center space-x-3">
            {logoUrl && (
              <OptimizedImage 
                src={logoUrl} 
                alt={tokenSymbol || 'Token'} 
                className="w-8 h-8 rounded-full"
                fallback={
                  <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-white text-sm font-bold">
                    {(tokenSymbol || '?').charAt(0).toUpperCase()}
                  </div>
                }
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
        <div className="p-6 space-y-6">
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

          {/* Configuration Performance Chart */}
          {configPerformanceChart && simulationData && (simulationData.buy_operation || simulationData.sell_operation) && (
            <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4 text-white">⚡ Configuration Performance</h3>
              
              {/* Chart */}
              <Bar
                data={configPerformanceChart.data as any}
                options={configPerformanceChart.options as any}
              />
              
                             {/* Performance summary */}
               <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 text-sm">
                 <div className="bg-gray-700/50 rounded-lg p-3">
                   <p className="text-gray-400 mb-1">Fastest Configuration</p>
                   {simulationData && (() => {
                     const fastest: ConfigurationResult | null = getFastestConfiguration(simulationData);
                     return fastest ? (
                       <div>
                         <p className="font-medium text-green-400">{fastest.type} {fastest.slippage}</p>
                         <p className="text-xs text-gray-400">{fastest.time}ms • {fastest.provider}</p>
                       </div>
                     ) : (
                       <p className="text-gray-500">No successful configs</p>
                     );
                   })()}
                 </div>
                 
                 <div className="bg-gray-700/50 rounded-lg p-3">
                   <p className="text-gray-400 mb-1">Success Rate</p>
                   {simulationData && (() => {
                     const { successCount, totalCount, rate } = getSuccessRate(simulationData);
                     return (
                       <div>
                         <p className="font-medium text-blue-400">{rate.toFixed(1)}%</p>
                         <p className="text-xs text-gray-400">{successCount}/{totalCount} configurations</p>
                       </div>
                     );
                   })()}
                 </div>
                 
                 <div className="bg-gray-700/50 rounded-lg p-3">
                   <p className="text-gray-400 mb-1">Average Response Time</p>
                   {simulationData && (() => {
                     const { avgTime, successCount } = getAverageResponseTime(simulationData);
                     return (
                       <div>
                         <p className="font-medium text-purple-400">{avgTime.toFixed(0)}ms</p>
                         <p className="text-xs text-gray-400">Across {successCount} successful configs</p>
                       </div>
                     );
                   })()}
                 </div>
               </div>
            </div>
          )}

          {/* Price history chart is always shown if we have enough data */}
          {priceHistory.length > 1 && (
            <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-4 text-white">📈 Price History (24h)</h3>

              {/* Chart */}
              <Line
                data={chartConfig.data as any}
                options={chartConfig.options as any}
              />

              {/* Quick stats */}
              {priceStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 text-sm">
                <div>
                  <p className="text-gray-400">Latest Price</p>
                    <p className="font-medium text-white">${priceStats.latestPrice.toFixed(6)}</p>
                </div>
                <div>
                  <p className="text-gray-400">Peak Price</p>
                    <p className="font-medium text-green-400">${priceStats.peakPrice.toFixed(6)}</p>
                </div>
                <div>
                  <p className="text-gray-400">Volatility (σ)</p>
                    <p className="font-medium text-white">{priceStats.volatility.toFixed(6)}</p>
                </div>
                <div>
                  <p className="text-gray-400">Total Volume</p>
                    <p className="font-medium text-blue-400">{priceStats.totalVolume.toLocaleString()}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Show message when insufficient price history */}
          {priceHistory.length <= 1 && (
            <div className="bg-blue-900/20 border border-blue-600/30 rounded-lg p-4">
              <h3 className="text-lg font-semibold mb-2 text-blue-400">📈 Price History (24h)</h3>
              <p className="text-blue-400/80">
                {priceHistory.length === 0 
                  ? 'No price history data available yet. Price tracking will begin on the next update cycle.'
                  : 'Insufficient data for chart display. Need at least 2 data points to show price trends.'
                }
              </p>
              {priceHistory.length === 1 && (
                <p className="text-blue-400/60 text-sm mt-2">
                  Current price: ${priceHistory[0].price_usd.toFixed(6)} • Volume: {priceHistory[0].volume?.toLocaleString() || 'N/A'}
                </p>
              )}
            </div>
          )}

          {/* Show warning if trade/simulation absent */}
          {!simulationData && priceHistory.length > 0 && !loading && (
            <div className="bg-red-900/20 border border-red-600/30 rounded-lg p-4">
              <h3 className="text-lg font-semibold text-red-400 mb-2">⚠️ Trade Execution Failed</h3>
              <p className="text-red-300 text-sm">No trading simulation or live trade data was recorded for this token. The buy transaction likely failed or was never submitted.</p>
            </div>
          )}

          {/* Simulation sections rendered below if data available */}
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
                    {Object.entries(simulationData.buy_operation.configurations).map(([key, configEntry]) => {
                      const config = configEntry as BuyConfigResult;
                      return (
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
                      );
                    })}
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
                    {Object.entries(simulationData.sell_operation.configurations).map(([key, configEntry]) => {
                      const config = configEntry as SellConfigResult;
                      return (
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
                      );
                    })}
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

// ----- Shared chart configuration helpers -----

interface PriceChartConfig {
  data: ChartData<'line' | 'bar', (number | null)[], string>
  options: ChartOptions<'line' | 'bar'>
}

// Build chart.js compatible config for the price/volume mixed chart
const getPriceHistoryChartConfig = (priceHistory: PriceRecord[]): PriceChartConfig => {
  const labels = priceHistory.map((p) => new Date(p.timestamp).toLocaleTimeString())

  const priceDataset: ChartDataset<'line' | 'bar', (number | null)[]> = {
    type: 'line',
    label: 'Price (USD)',
    data: priceHistory.map((p) => p.price_usd),
    borderColor: '#4ade80',
    backgroundColor: 'rgba(74,222,128,0.2)',
    yAxisID: 'y',
  }

  const volumeDataset: ChartDataset<'line' | 'bar', (number | null)[]> = {
    type: 'bar',
    label: 'Volume',
    data: priceHistory.map((p) => p.volume || 0),
    backgroundColor: 'rgba(59,130,246,0.4)',
    borderColor: '#3b82f6',
    yAxisID: 'y1',
  }

  const data: ChartData<'line' | 'bar', (number | null)[], string> = {
    labels,
    datasets: [priceDataset, volumeDataset],
  }

  const options: ChartOptions<'line' | 'bar'> = {
    responsive: true,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    scales: {
      y: {
        type: 'linear',
        display: true,
        position: 'left',
        ticks: { color: '#4ade80' },
      },
      y1: {
        type: 'linear',
        display: true,
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: '#3b82f6' },
      },
      x: {
        ticks: { color: '#d1d5db' },
      },
    },
    plugins: {
      legend: { labels: { color: '#d1d5db' } },
      tooltip: { mode: 'index', intersect: false },
    },
  }

  return { data, options }
}

// Build chart.js compatible config for trading configuration performance comparison
const getConfigurationPerformanceChartConfig = (simulationData: TradingSimulationData): PriceChartConfig => {
  const configData: Array<{
    label: string
    responseTime: number
    success: boolean
    fees: number
    provider: string
    operation: 'buy' | 'sell'
    slippage: string
  }> = []

  // Extract buy operation configurations
  if (simulationData.buy_operation?.configurations) {
    Object.entries(simulationData.buy_operation.configurations).forEach(([key, config]) => {
      const slippage = key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%'
      configData.push({
        label: `Buy ${slippage}`,
        responseTime: config.response_time,
        success: config.success,
        fees: config.total_fees,
        provider: config.best_provider,
        operation: 'buy',
        slippage
      })
    })
  }

  // Extract sell operation configurations
  if (simulationData.sell_operation?.configurations) {
    Object.entries(simulationData.sell_operation.configurations).forEach(([key, config]) => {
      const slippage = key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%'
      configData.push({
        label: `Sell ${slippage}`,
        responseTime: config.response_time,
        success: config.success,
        fees: config.total_fees,
        provider: config.best_provider,
        operation: 'sell',
        slippage
      })
    })
  }

  const labels = configData.map(item => item.label)

  // Response time dataset (primary)
  const responseTimeDataset: ChartDataset<'bar', (number | null)[]> = {
    type: 'bar',
    label: 'Response Time (ms)',
    data: configData.map(item => item.success ? item.responseTime : 0),
    backgroundColor: configData.map(item => {
      if (!item.success) return 'rgba(239, 68, 68, 0.8)' // Red for failed
      if (item.operation === 'buy') return 'rgba(34, 197, 94, 0.8)' // Green for buy
      return 'rgba(59, 130, 246, 0.8)' // Blue for sell
    }),
    borderColor: configData.map(item => {
      if (!item.success) return 'rgb(239, 68, 68)'
      if (item.operation === 'buy') return 'rgb(34, 197, 94)'
      return 'rgb(59, 130, 246)'
    }),
    borderWidth: 1,
    yAxisID: 'y',
  }

  // Fees dataset (secondary axis)
  const feesDataset: ChartDataset<'bar', (number | null)[]> = {
    type: 'bar',
    label: 'Total Fees (SOL)',
    data: configData.map(item => item.success ? item.fees : 0),
    backgroundColor: 'rgba(168, 85, 247, 0.4)',
    borderColor: 'rgb(168, 85, 247)',
    borderWidth: 1,
    yAxisID: 'y1',
  }

  const data: ChartData<'bar', (number | null)[], string> = {
    labels,
    datasets: [responseTimeDataset, feesDataset],
  }

  const options: ChartOptions<'bar'> = {
    responsive: true,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    indexAxis: 'x',
    scales: {
      y: {
        type: 'linear',
        display: true,
        position: 'left',
        title: {
          display: true,
          text: 'Response Time (ms)',
          color: '#d1d5db'
        },
        ticks: { color: '#d1d5db' },
        grid: { color: 'rgba(209, 213, 219, 0.1)' }
      },
      y1: {
        type: 'linear',
        display: true,
        position: 'right',
        title: {
          display: true,
          text: 'Fees (SOL)',
          color: '#a855f7'
        },
        grid: { drawOnChartArea: false },
        ticks: { color: '#a855f7' },
      },
      x: {
        ticks: { color: '#d1d5db' },
        grid: { color: 'rgba(209, 213, 219, 0.1)' }
      },
    },
    plugins: {
      legend: { 
        labels: { color: '#d1d5db' },
        position: 'top'
      },
      tooltip: { 
        mode: 'index', 
        intersect: false,
        callbacks: {
          afterLabel: function(context) {
            const index = context.dataIndex
            const config = configData[index]
            if (!config) return ''
            
            return [
              `Provider: ${config.provider}`,
              `Status: ${config.success ? '✅ Success' : '❌ Failed'}`,
              `Slippage: ${config.slippage}`
            ]
          }
        }
      },
    },
  }

  return { data, options }
} 