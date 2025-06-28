'use client'

import React, { useState, useEffect } from 'react'

interface TradeComparisonData {
  token_address: string
  token_symbol: string | null
  timestamp: string
  buy_amount_sol: number
  comparisons: {
    slippage_1: {
      success: boolean
      response_time: number
      token_amount: string
      total_fees: number
      price_impact: string
      best_provider: string
      error?: string
    }
    slippage_2: {
      success: boolean
      response_time: number
      token_amount: string
      total_fees: number
      price_impact: string
      best_provider: string
      error?: string
    }
    slippage_5: {
      success: boolean
      response_time: number
      token_amount: string
      total_fees: number
      price_impact: string
      best_provider: string
      error?: string
    }
  }
  best_config: {
    slippage: number
    provider: string
    token_amount: string
    response_time: number
    total_fees: number
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
  const [tradeData, setTradeData] = useState<TradeComparisonData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    if (isOpen && tokenAddress) {
      fetchTradeComparisonData()
    }
  }, [isOpen, tokenAddress])

  const fetchTradeComparisonData = async () => {
    try {
      setLoading(true)
      setError('')
      
      const response = await fetch(`/api/trending/track?token=${tokenAddress}`)
      
      if (!response.ok) {
        throw new Error(`Failed to fetch trade comparison data: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.success && data.token.trade_comparison_data) {
        setTradeData(data.token.trade_comparison_data)
      } else {
        setError('No trade comparison data available for this token')
      }
    } catch (error) {
      console.error('Error fetching trade comparison data:', error)
      setError(error instanceof Error ? error.message : 'Failed to fetch trade comparison data')
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

  const getStatusColor = (success: boolean) => {
    return success ? 'text-green-600' : 'text-red-600'
  }

  const getStatusIcon = (success: boolean) => {
    return success ? '✅' : '❌'
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
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
                Trade Comparison: {tokenSymbol || 'Unknown Token'}
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
              <span className="ml-2">Loading trade comparison data...</span>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p className="text-red-600">{error}</p>
            </div>
          )}

          {tradeData && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-blue-900 mb-2">Best Configuration</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-sm text-blue-700">Slippage</p>
                    <p className="font-semibold">{tradeData.best_config.slippage}%</p>
                  </div>
                  <div>
                    <p className="text-sm text-blue-700">Provider</p>
                    <p className="font-semibold capitalize">{tradeData.best_config.provider}</p>
                  </div>
                  <div>
                    <p className="text-sm text-blue-700">Token Amount</p>
                    <p className="font-semibold">{formatTokenAmount(tradeData.best_config.token_amount)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-blue-700">Response Time</p>
                    <p className="font-semibold">{tradeData.best_config.response_time}ms</p>
                  </div>
                </div>
              </div>

              {/* Detailed Comparisons */}
              <div>
                <h3 className="text-lg font-semibold mb-4">Slippage Configuration Comparison</h3>
                <div className="grid gap-4">
                  {Object.entries(tradeData.comparisons).map(([key, config]) => (
                    <div key={key} className="border rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-semibold capitalize">
                          {key.replace('_', ' ')} ({key.includes('1') ? '1%' : key.includes('2') ? '2%' : '5%'} slippage)
                        </h4>
                        <span className={`font-semibold ${getStatusColor(config.success)}`}>
                          {getStatusIcon(config.success)} {config.success ? 'Success' : 'Failed'}
                        </span>
                      </div>
                      
                      {config.success ? (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div>
                            <p className="text-sm text-gray-600">Provider</p>
                            <p className="font-medium capitalize">{config.best_provider}</p>
                          </div>
                          <div>
                            <p className="text-sm text-gray-600">Token Amount</p>
                            <p className="font-medium">{formatTokenAmount(config.token_amount)}</p>
                          </div>
                          <div>
                            <p className="text-sm text-gray-600">Response Time</p>
                            <p className="font-medium">{config.response_time}ms</p>
                          </div>
                          <div>
                            <p className="text-sm text-gray-600">Total Fees</p>
                            <p className="font-medium">{formatNumber(config.total_fees, 6)} SOL</p>
                          </div>
                          <div>
                            <p className="text-sm text-gray-600">Price Impact</p>
                            <p className="font-medium">{parseFloat(config.price_impact).toFixed(2)}%</p>
                          </div>
                        </div>
                      ) : (
                        <div className="text-red-600">
                          <p className="text-sm">Error: {config.error || 'Unknown error'}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Test Configuration */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <h3 className="text-lg font-semibold mb-2">Test Configuration</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-gray-600">Buy Amount</p>
                    <p className="font-medium">{tradeData.buy_amount_sol} SOL</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Test Time</p>
                    <p className="font-medium">{new Date(tradeData.timestamp).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Token Address</p>
                    <p className="font-mono text-xs break-all">{tokenAddress}</p>
                  </div>
                </div>
              </div>
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