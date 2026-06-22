'use client'

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

interface TradeComparisonData {
  token_address: string
  token_symbol: string | null
  timestamp: string
  buy_amount_sol: number
  comparisons: {
    [key: string]: {
      success: boolean
      response_time: number
      token_amount: string
      total_fees: number
      price_impact: string
      best_provider: string
      rpc_used?: string
      error?: string
    }
  }
  best_config: {
    slippage: number
    provider: string
    token_amount: string
    response_time: number
    total_fees: number
    rpc_used?: string
  }
  provider_performance?: {
    [provider: string]: {
      success_rate: number
      avg_response_time: number
      total_attempts: number
      successful_attempts: number
      failed_attempts: number
      logs: Array<{
        timestamp: string
        action: string
        result: string
        duration: number
        error?: string
      }>
    }
  }
  rpc_performance?: {
    [rpc: string]: {
      success_rate: number
      avg_response_time: number
      total_attempts: number
      successful_attempts: number
      failed_attempts: number
      logs: Array<{
        timestamp: string
        action: string
        result: string
        duration: number
        error?: string
      }>
    }
  }
}

interface TradeComparisonModalProps {
  isOpen: boolean
  onClose: () => void
  tokenAddress: string
  tokenSymbol: string | null
  tokenName: string | null
  logoUrl: string | null
}

export default function TradeComparisonModal({
  isOpen,
  onClose,
  tokenAddress,
  tokenSymbol,
  tokenName,
  logoUrl
}: TradeComparisonModalProps) {
  const [refreshId, setRefreshId] = useState(0)

  const {
    data: apiData,
    isFetching: loading,
    error: queryError,
  } = useQuery({
    queryKey: ['tradeComparison', tokenAddress, refreshId],
    queryFn: async () => {
      const url = refreshId
        ? `/api/trending/track?token=${tokenAddress}&refresh=true&t=${Date.now()}`
        : `/api/trending/track?token=${tokenAddress}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    enabled: isOpen && !!tokenAddress,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  })

  const tradeData: TradeComparisonData | null = (apiData as any)?.token?.trade_comparison_data ?? null
  const error = queryError ? (queryError as Error).message : ''

  const handleReset = () => {
    setRefreshId(id => id + 1)
  }

  const handleTest = () => {
    if (!loading) setRefreshId(id => id + 1)
  }

  const formatNumber = (num: number, decimals: number = 6) => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(num)
  }

  const formatTokenAmount = (amount: string) => {
    const num = parseFloat(amount) / 1_000_000_000 // Convert from lamports to SOL
    if (num === 0) return '0'
    if (num < 0.000001) return '< 0.000001'
    return formatNumber(num, 6)
  }

  const getStatusColor = (success: boolean) => {
    return success ? 'text-green-400' : 'text-red-400'
  }

  const getStatusIcon = (success: boolean) => {
    return success ? '✅' : '❌'
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 flex items-stretch z-50">
      <div className="bg-gray-900 w-full min-h-screen overflow-y-auto text-white">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {logoUrl && (
                <OptimizedImage 
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
                  Trade Comparison: {tokenSymbol || 'Unknown Token'}
                </h2>
                <p className="text-sm text-gray-400">
                  {tokenName || tokenAddress}
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={handleTest}
                disabled={loading}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  loading
                    ? 'bg-blue-600/50 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {loading ? (
                  <span className="flex items-center">
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Testing...
                  </span>
                ) : (
                  <span className="flex items-center">
                    <svg className="mr-1.5 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Test Again
                  </span>
                )}
              </button>
              <button
                onClick={handleReset}
                disabled={loading}
                className={`px-4 py-2 rounded-lg font-medium transition-all ${
                  loading
                    ? 'bg-gray-600/50 cursor-not-allowed'
                    : 'bg-gray-600 hover:bg-gray-700'
                }`}
              >
                <span className="flex items-center">
                  <svg className="mr-1.5 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Reset
                </span>
              </button>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-200 text-2xl ml-4"
              >
                ×
              </button>
            </div>
          </div>
          {loading && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5">
              <div className="absolute h-full bg-blue-500 animate-[progress_2s_ease-in-out_infinite]" style={{width: '25%'}}></div>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-6 space-y-8">
          {error && (
            <div className="bg-red-900/20 border border-red-800/30 rounded-xl p-4 mb-6">
              <p className="text-red-400">{error}</p>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
              <span className="ml-2 text-gray-400">Loading trade comparison data...</span>
            </div>
          )}

          {tradeData && (
            <>
              {/* Summary Section */}
              <div className="bg-gray-800 rounded-xl p-6">
                <h3 className="text-lg font-semibold mb-4">Trade Summary</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-sm text-gray-400">Buy Amount</p>
                    <p className="text-white font-semibold">{tradeData.buy_amount_sol} SOL</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-400">Best Provider</p>
                    <p className="text-white font-semibold">{tradeData.best_config.provider}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-400">Best Token Amount</p>
                    <p className="text-white font-semibold">{formatTokenAmount(tradeData.best_config.token_amount)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-400">Best RPC</p>
                    <p className="text-white font-semibold">
                      {tradeData.best_config.rpc_used || 'N/A'}
                      {tradeData.best_config.response_time !== undefined && (
                        <span className="text-gray-400 text-xs ml-2">({tradeData.best_config.response_time}ms)</span>
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {/* Provider Performance */}
              {tradeData.provider_performance && (
                <div className="bg-gray-800 rounded-xl p-6">
                  <h3 className="text-lg font-semibold mb-4">Provider Performance</h3>
                  <div className="space-y-4">
                    {Object.entries(tradeData.provider_performance).map(([provider, stats]) => (
                      <div key={provider} className="bg-gray-700/50 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="font-medium text-white">{provider}</h4>
                          <span className={`px-2 py-1 rounded text-sm ${
                            stats.success_rate >= 70 ? 'bg-green-900/50 text-green-400' :
                            stats.success_rate >= 50 ? 'bg-yellow-900/50 text-yellow-400' :
                            'bg-red-900/50 text-red-400'
                          }`}>
                            {stats.success_rate.toFixed(1)}% Success
                          </span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                          <div>
                            <p className="text-gray-400">Avg Response</p>
                            <p className="text-white">{stats.avg_response_time.toFixed(0)}ms</p>
                          </div>
                          <div>
                            <p className="text-gray-400">Total Attempts</p>
                            <p className="text-white">{stats.total_attempts}</p>
                          </div>
                          <div>
                            <p className="text-gray-400">Successful</p>
                            <p className="text-green-400">{stats.successful_attempts}</p>
                          </div>
                          <div>
                            <p className="text-gray-400">Failed</p>
                            <p className="text-red-400">{stats.failed_attempts}</p>
                          </div>
                        </div>
                        {/* Provider Logs */}
                        {stats.logs && stats.logs.length > 0 && (
                          <div className="mt-4">
                            <p className="text-sm text-gray-400 mb-2">Recent Logs</p>
                            <div className="space-y-2 max-h-40 overflow-y-auto">
                              {stats.logs.map((log, index) => (
                                <div key={index} className="text-sm bg-gray-800/50 rounded p-2">
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                    <span className={log.error ? 'text-red-400' : 'text-green-400'}>
                                      {log.duration}ms
                                    </span>
                                  </div>
                                  <p className="text-white">{log.action}: {log.result}</p>
                                  {log.error && (
                                    <p className="text-red-400 text-sm mt-1">{log.error}</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* RPC Performance */}
              {tradeData.rpc_performance && (
                <div className="bg-gray-800 rounded-xl p-6">
                  <h3 className="text-lg font-semibold mb-4">RPC Performance</h3>
                  <div className="space-y-4">
                    {Object.entries(tradeData.rpc_performance).map(([rpc, stats]) => (
                      <div key={rpc} className="bg-gray-700/50 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="font-medium text-white">{rpc}</h4>
                          <span className={`px-2 py-1 rounded text-sm ${
                            stats.success_rate >= 70 ? 'bg-green-900/50 text-green-400' :
                            stats.success_rate >= 50 ? 'bg-yellow-900/50 text-yellow-400' :
                            'bg-red-900/50 text-red-400'
                          }`}>
                            {stats.success_rate.toFixed(1)}% Success
                          </span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                          <div>
                            <p className="text-gray-400">Avg Response</p>
                            <p className="text-white">{stats.avg_response_time.toFixed(0)}ms</p>
                          </div>
                          <div>
                            <p className="text-gray-400">Total Attempts</p>
                            <p className="text-white">{stats.total_attempts}</p>
                          </div>
                          <div>
                            <p className="text-gray-400">Successful</p>
                            <p className="text-green-400">{stats.successful_attempts}</p>
                          </div>
                          <div>
                            <p className="text-gray-400">Failed</p>
                            <p className="text-red-400">{stats.failed_attempts}</p>
                          </div>
                        </div>
                        {/* RPC Logs */}
                        {stats.logs && stats.logs.length > 0 && (
                          <div className="mt-4">
                            <p className="text-sm text-gray-400 mb-2">Recent Logs</p>
                            <div className="space-y-2 max-h-40 overflow-y-auto">
                              {stats.logs.map((log, index) => (
                                <div key={index} className="text-sm bg-gray-800/50 rounded p-2">
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                    <span className={log.error ? 'text-red-400' : 'text-green-400'}>
                                      {log.duration}ms
                                    </span>
                                  </div>
                                  <p className="text-white">{log.action}: {log.result}</p>
                                  {log.error && (
                                    <p className="text-red-400 text-sm mt-1">{log.error}</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Comparison Results */}
              <div className="bg-gray-800 rounded-xl p-6">
                <h3 className="text-lg font-semibold mb-4">Comparison Results</h3>
                <div className="space-y-8">
                  {Object.entries(tradeData.comparisons).map(([config, result]) => {
                    // Gather all logs for this config from provider_performance
                    let allLogs: Array<any> = []
                    if (tradeData.provider_performance) {
                      Object.entries(tradeData.provider_performance).forEach(([provider, stats]) => {
                        if (stats.logs && stats.logs.length > 0) {
                          // Try to filter logs by config/slippage if present in log.action or log.result
                          const configLogs = stats.logs.filter(log => {
                            // Try to match config/slippage in log.action or log.result
                            const action = log.action?.toLowerCase() || ''
                            const resultStr = log.result?.toLowerCase() || ''
                            return action.includes(config.toLowerCase()) || resultStr.includes(config.toLowerCase())
                          })
                          if (configLogs.length > 0) {
                            allLogs = allLogs.concat(configLogs.map(log => ({...log, provider})))
                          }
                        }
                      })
                    }
                    // Fallback: if no logs matched, show all logs for the token
                    if (allLogs.length === 0 && tradeData.provider_performance) {
                      Object.entries(tradeData.provider_performance).forEach(([provider, stats]) => {
                        if (stats.logs && stats.logs.length > 0) {
                          allLogs = allLogs.concat(stats.logs.map(log => ({...log, provider})))
                        }
                      })
                    }
                    return (
                      <div key={config} className="bg-gray-700/50 rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="font-medium text-white">Configuration: {config}</h4>
                          <span className={`flex items-center ${getStatusColor(result.success)}`}>
                            {getStatusIcon(result.success)} {result.success ? 'Success' : 'Failed'}
                          </span>
                        </div>
                        {/* Table of all attempts for this config */}
                        {allLogs.length > 0 ? (
                          <div className="overflow-x-auto mt-2">
                            <table className="min-w-full text-sm text-left">
                              <thead>
                                <tr className="text-gray-400 border-b border-gray-600">
                                  <th className="px-2 py-1">Provider</th>
                                  <th className="px-2 py-1">RPC</th>
                                  <th className="px-2 py-1">Token Amount</th>
                                  <th className="px-2 py-1">Response Time</th>
                                  <th className="px-2 py-1">Price Impact</th>
                                  <th className="px-2 py-1">Success</th>
                                  <th className="px-2 py-1">Error</th>
                                </tr>
                              </thead>
                              <tbody>
                                {allLogs.map((log, idx) => (
                                  <tr key={idx} className="border-b border-gray-700">
                                    <td className="px-2 py-1">{log.provider || '-'}</td>
                                    <td className="px-2 py-1">{log.rpc || '-'}</td>
                                    <td className="px-2 py-1">{log.token_amount !== undefined ? formatTokenAmount(log.token_amount) : '-'}</td>
                                    <td className="px-2 py-1">{log.duration !== undefined ? `${log.duration}ms` : '-'}</td>
                                    <td className="px-2 py-1">{log.price_impact !== undefined ? `${log.price_impact}%` : '-'}</td>
                                    <td className="px-2 py-1">
                                      {log.error ? (
                                        <span className="text-red-400">❌</span>
                                      ) : (
                                        <span className="text-green-400">✅</span>
                                      )}
                                    </td>
                                    <td className="px-2 py-1 text-red-400">{log.error || '-'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="text-gray-400 text-sm mt-2">No detailed logs available for this configuration.</div>
                        )}
                        {/* Best result summary (as before) */}
                        <div className="mt-4">
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                            <div>
                              <p className="text-gray-400">Provider</p>
                              <p className="text-white">{result.best_provider}</p>
                            </div>
                            <div>
                              <p className="text-gray-400">Token Amount</p>
                              <p className="text-white">{formatTokenAmount(result.token_amount)}</p>
                            </div>
                            <div>
                              <p className="text-gray-400">Response Time</p>
                              <p className="text-white">{result.response_time}ms</p>
                            </div>
                            <div>
                              <p className="text-gray-400">Price Impact</p>
                              <p className="text-white">{result.price_impact}%</p>
                            </div>
                            <div>
                              <p className="text-gray-400">RPC Used</p>
                              <p className="text-white">{result.rpc_used || 'N/A'}</p>
                            </div>
                          </div>
                        </div>
                        {!result.success && (
                          <p className="text-red-400 text-sm mt-2">{result.error || 'Failed to get quote'}</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
} 