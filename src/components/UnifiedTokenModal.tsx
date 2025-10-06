'use client'

import React, { useEffect, useState } from 'react'
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
import { BulkBuyResult } from '@/types'
import { BulkSellResult } from '@/utils/jupiter'

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, BarElement, Tooltip, Legend)

type CloseResult = {
  successful: string[]
  failed: Array<{ mintAddress: string; error: string }>
  signatures: string[]
}

interface TradingSimulationData {
  token_address: string
  token_symbol: string | null
  simulation_started_at: string
  buy_operation: any
  sell_operation: any
  current_status: 'buying' | 'holding' | 'selling' | 'completed' | 'failed'
  target_gain_percentage: number
  stop_loss_percentage: number
  max_hold_hours: number
  final_result: any
}

interface PriceRecord {
  timestamp: string
  price_usd: number
  volume: number | null
}

type UnifiedTokenModalProps = {
  isOpen: boolean
  onClose: () => void
  
  // Transaction Result Props
  operation?: 'buy' | 'sell' | 'close'
  result?: BulkBuyResult | BulkSellResult | CloseResult | null
  balanceBefore?: number
  balanceAfter?: number
  solToUsd?: (solValue: number) => number
  onSelectToken?: (mintAddress: string) => void
  pointsEarned?: number
  
  // Trading Simulation Props
  tokenAddress?: string
  tokenSymbol?: string | null
  tokenName?: string | null
  logoUrl?: string | null
  isSimulated?: boolean
  keypairPath?: string
  onTradeTriggered?: (type: string, details: any) => Promise<void>
  
  // Modal type
  modalType: 'transaction' | 'trading'
}

export default function UnifiedTokenModal({
  isOpen,
  onClose,
  operation,
  result,
  balanceBefore,
  balanceAfter,
  solToUsd = (sol) => sol * 145,
  onSelectToken,
  pointsEarned,
  tokenAddress,
  tokenSymbol,
  tokenName,
  logoUrl,
  isSimulated = true,
  keypairPath = '',
  onTradeTriggered,
  modalType
}: UnifiedTokenModalProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'charts' | 'raw-json'>('overview')
  const [tokenNames, setTokenNames] = useState<Record<string, string>>({})
  const [simulationData, setSimulationData] = useState<TradingSimulationData | null>(null)
  const [priceHistory, setPriceHistory] = useState<PriceRecord[]>([])
  const [rawJsonData, setRawJsonData] = useState<any>(null)
  const [refreshId, setRefreshId] = useState(0)

  // Trading simulation data fetching
  const {
    data: apiData,
    isFetching: loading,
    error: queryError,
  } = useQuery({
    queryKey: ['tradingSimulation', tokenAddress, refreshId],
    queryFn: async () => {
      if (!tokenAddress) return null
      const url = `/api/trending/track?token=${tokenAddress}&isSimulated=${isSimulated}&keypairPath=${encodeURIComponent(keypairPath)}&t=${Date.now()}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setRawJsonData(data) // Store raw JSON response
      return data
    },
    enabled: isOpen && modalType === 'trading' && !!tokenAddress,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  })

  // Store raw JSON for transaction results
  useEffect(() => {
    if (modalType === 'transaction' && result) {
      setRawJsonData(result)
    }
  }, [modalType, result])

  // Update simulation data when API data changes
  useEffect(() => {
    if (!apiData || !apiData.success) return

    if (apiData.token) {
      if (apiData.token.price_history) {
        setPriceHistory(apiData.token.price_history)
      }
      if (apiData.token.trading_simulation) {
        setSimulationData(apiData.token.trading_simulation)
      }
    }
  }, [apiData])

  // Fetch token metadata for transaction results
  useEffect(() => {
    if (!isOpen || modalType !== 'transaction' || !result || !('successful' in result)) return

    const closeResult = result as CloseResult
    const mints = Array.from(
      new Set([
        ...closeResult.successful,
        ...closeResult.failed.map(f => f.mintAddress)
      ])
    )

    const mintsToFetch = mints.filter(m => !tokenNames[m])
    if (mintsToFetch.length === 0) return

    ;(async () => {
      const updates: Record<string, string> = {}
      await Promise.all(
        mintsToFetch.map(async (mint) => {
          try {
            const res = await fetch(`/api/jupiter/metadata?mint=${mint}`)
            if (!res.ok) return
            const json = await res.json()
            const symbol = json?.data?.symbol || json?.data?.name
            if (symbol) {
              updates[mint] = symbol
            }
          } catch {
            /* silent */
          }
        })
      )
      if (Object.keys(updates).length > 0) {
        setTokenNames(prev => ({ ...prev, ...updates }))
      }
    })()
  }, [isOpen, modalType, result, tokenNames])

  // Close modal on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = 'unset'
    }
  }, [isOpen, onClose])

  // Helper functions
  const getTokenName = (mint: string): string => {
    const cached = tokenNames[mint]
    if (cached) return cached
    return `${mint.slice(0, 4)}...${mint.slice(-4)}`
  }

  const isUserRejection = (error: string): boolean => {
    const rejectionPhrases = [
      'user rejected',
      'user denied',
      'user cancelled',
      'user canceled',
      'transaction was not confirmed',
      'rejected by user',
      'declined by user'
    ]
    return rejectionPhrases.some(phrase => 
      error.toLowerCase().includes(phrase.toLowerCase())
    )
  }

  const checkForUserRejection = (): boolean => {
    if (!result) return false

    if ('failedPurchases' in result) {
      return result.failedPurchases.some(failure => 
        isUserRejection(failure.error)
      )
    } else if ('failedSwaps' in result) {
      return result.failedSwaps.some(failure => 
        isUserRejection(failure.error)
      )
    } else if ('failed' in result) {
      return result.failed.some(failure => 
        isUserRejection(failure.error)
      )
    }
    return false
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-400'
      case 'failed': return 'text-red-400'
      case 'buying': case 'selling': return 'text-yellow-400'
      case 'holding': return 'text-blue-400'
      default: return 'text-gray-400'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return '✅'
      case 'failed': return '❌'
      case 'buying': return '🛒'
      case 'selling': return '💰'
      case 'holding': return '⏳'
      default: return '❓'
    }
  }

  // Don't render if should hide
  const shouldHide = !isOpen || (modalType === 'transaction' && (!result || checkForUserRejection()))
  if (shouldHide) {
    return null
  }

  const renderTransactionResult = () => {
    if (!result) return null

    if ('successfulPurchases' in result) {
      // BulkBuyResult
      const buyResult = result as BulkBuyResult
      const successfulTokens = buyResult.successfulPurchases.map(purchase => {
        if (purchase.symbol) return purchase.symbol
        if (purchase.name) return purchase.name
        return purchase.mintAddress.slice(0, 4) + '...' + purchase.mintAddress.slice(-4)
      })

      return (
        <div className="space-y-6">
          <div className={`border rounded-xl p-8 text-center backdrop-blur-sm ${
            buyResult.success 
              ? 'bg-gradient-to-r from-blue-900/50 to-indigo-800/50 border-blue-500/50' 
              : 'bg-gradient-to-r from-red-900/50 to-red-800/50 border-red-500/50'
          }`}>
            <div className="text-6xl mb-4">🚀</div>
            <h3 className={`font-bold text-2xl mb-4 ${buyResult.success ? 'text-blue-200' : 'text-red-200'}`}>
              {buyResult.success ? 'Congratulations!' : 'Transaction Completed'}
            </h3>
            
            {buyResult.success && successfulTokens.length > 0 && (
              <div className="mb-6">
                <p className="text-lg text-blue-200 mb-2">
                  You've successfully bought:
                </p>
                <div className="flex flex-wrap justify-center gap-2 mb-4">
                  {successfulTokens.slice(0, 5).map((token, index) => (
                    <span key={index} className="bg-blue-800/30 text-blue-100 px-3 py-1 rounded-full text-sm font-mono">
                      {token}
                    </span>
                  ))}
                  {successfulTokens.length > 5 && (
                    <span className="bg-blue-800/30 text-blue-100 px-3 py-1 rounded-full text-sm">
                      +{successfulTokens.length - 5} more
                    </span>
                  )}
                </div>
              </div>
            )}

            {buyResult.success && typeof pointsEarned === 'number' && (
              <div className="mt-4 text-blue-300 text-lg font-semibold">
                🎯 Points Earned: {pointsEarned}
              </div>
            )}
          </div>

          {/* Transaction Details */}
          <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-4 text-white">Transaction Details</h3>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-400">Successful Purchases</p>
                <p className="font-medium text-green-400">{buyResult.successfulPurchases.length}</p>
              </div>
              <div>
                <p className="text-gray-400">Failed Purchases</p>
                <p className="font-medium text-red-400">{buyResult.failedPurchases.length}</p>
              </div>
              {balanceBefore !== undefined && balanceAfter !== undefined && (
                <>
                  <div>
                    <p className="text-gray-400">Balance Before</p>
                    <p className="font-medium text-white">{balanceBefore.toFixed(4)} SOL</p>
                  </div>
                  <div>
                    <p className="text-gray-400">Balance After</p>
                    <p className="font-medium text-white">{balanceAfter.toFixed(4)} SOL</p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )
    }

    // Handle other result types (sell, close) similarly...
    return <div className="text-gray-400">Transaction result display not implemented for this type</div>
  }

  const renderTradingSimulation = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-8 text-gray-300">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400"></div>
          <span className="ml-2">Loading trading simulation data...</span>
        </div>
      )
    }

    if (queryError) {
      return (
        <div className="bg-red-900/20 border border-red-600/30 rounded-lg p-4">
          <p className="text-red-400">{(queryError as Error).message}</p>
        </div>
      )
    }

    if (!simulationData) {
      return (
        <div className="bg-yellow-900/20 border border-yellow-600/30 rounded-lg p-4">
          <p className="text-yellow-400">No trading simulation data available</p>
        </div>
      )
    }

    return (
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

        {/* Price History Chart */}
        {priceHistory.length > 1 && (
          <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
            <h3 className="text-lg font-semibold mb-4 text-white">📈 Price History (24h)</h3>
            <div className="h-64 flex items-center justify-center text-gray-400">
              <Line
                data={{
                  labels: priceHistory.map(p => new Date(p.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
                  datasets: [
                    {
                      label: 'Price (USD)',
                      data: priceHistory.map(p => p.price_usd),
                      borderColor: '#60a5fa',
                      backgroundColor: 'rgba(96,165,250,0.1)',
                      pointRadius: 0,
                      tension: 0.2,
                      fill: true,
                    }
                  ]
                }}
                options={{
                  responsive: true,
                  plugins: {
                    legend: { display: false },
                    tooltip: { mode: 'index', intersect: false }
                  },
                  scales: {
                    x: {
                      title: { display: true, text: 'Time' },
                      grid: { display: false },
                      ticks: { color: '#a3a3a3', maxTicksLimit: 8 }
                    },
                    y: {
                      title: { display: true, text: 'Price (USD)' },
                      grid: { color: 'rgba(96,165,250,0.05)' },
                      ticks: { color: '#a3a3a3' }
                    }
                  }
                }}
                height={220}
              />
            </div>
          </div>
        )}
        {priceHistory.length <= 1 && (
          <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
            <p className="text-gray-400">Not enough price history to display chart.</p>
          </div>
        )}
      </div>
    )
  }

  const renderRawJson = () => {
    if (!rawJsonData) {
      return (
        <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
          <p className="text-gray-400">No raw JSON data available</p>
        </div>
      )
    }

    return (
      <div className="bg-gray-900/50 border border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Raw JSON Response</h3>
          <button
            onClick={() => {
              navigator.clipboard.writeText(JSON.stringify(rawJsonData, null, 2))
            }}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
          >
            Copy JSON
          </button>
        </div>
        <pre className="bg-black/50 p-4 rounded-lg overflow-auto max-h-96 text-sm text-green-400 font-mono">
          {JSON.stringify(rawJsonData, null, 2)}
        </pre>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <div className="flex items-center space-x-3">
            {logoUrl && (
              <img src={logoUrl} alt="Token" className="w-10 h-10 rounded-full" />
            )}
            <div>
              <h2 className="text-xl font-bold text-white">
                {modalType === 'trading' 
                  ? `${isSimulated ? 'Trading Simulation' : 'Live Trading'}: ${tokenSymbol || 'Unknown Token'}`
                  : `Transaction Result: ${operation?.toUpperCase()}`
                }
              </h2>
              <p className="text-sm text-gray-400">
                {modalType === 'trading' 
                  ? (tokenName || tokenAddress)
                  : `${new Date().toLocaleString()}`
                }
              </p>
              {modalType === 'trading' && !isSimulated && (
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

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-700">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'overview'
                ? 'text-blue-400 border-b-2 border-blue-400 bg-blue-900/20'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Overview
          </button>
          {modalType === 'trading' && (
            <button
              onClick={() => setActiveTab('charts')}
              className={`px-6 py-3 font-medium transition-colors ${
                activeTab === 'charts'
                  ? 'text-blue-400 border-b-2 border-blue-400 bg-blue-900/20'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Charts
            </button>
          )}
          <button
            onClick={() => setActiveTab('raw-json')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'raw-json'
                ? 'text-blue-400 border-b-2 border-blue-400 bg-blue-900/20'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Raw JSON
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-200px)]">
          {activeTab === 'overview' && (
            modalType === 'transaction' ? renderTransactionResult() : renderTradingSimulation()
          )}
          {activeTab === 'charts' && modalType === 'trading' && (
            <div className="space-y-6">
              {/* Additional charts would go here */}
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-4">
                <h3 className="text-lg font-semibold mb-4 text-white">📊 Advanced Charts</h3>
                <p className="text-gray-400">Advanced chart visualizations would be displayed here</p>
              </div>
            </div>
          )}
          {activeTab === 'raw-json' && renderRawJson()}
        </div>
      </div>
    </div>
  )
}