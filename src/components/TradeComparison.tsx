'use client'

import React, { useState, useCallback } from 'react'
import { TradeComparison as TradeComparisonType, TradeProvider, ProviderQuote } from '@/types'

interface TradeComparisonProps {
  userPublicKey: string | null
}

interface FormData {
  inputMint: string
  outputMint: string
  amount: string
  slippageBps: number
}

// Common token addresses for quick selection
const COMMON_TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
}

export default function TradeComparison({ userPublicKey }: TradeComparisonProps) {
  const [formData, setFormData] = useState<FormData>({
    inputMint: COMMON_TOKENS.SOL,
    outputMint: COMMON_TOKENS.USDC,
    amount: '1',
    slippageBps: 100
  })
  
  const [comparison, setComparison] = useState<TradeComparisonType | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPoolsTest, setShowPoolsTest] = useState(false)
  const [poolsTestResults, setPoolsTestResults] = useState<any>(null)
  const [poolsLoading, setPoolsLoading] = useState(false)

  const handleCompareQuotes = useCallback(async () => {
    if (!userPublicKey) {
      setError('Please connect your wallet first')
      return
    }

    setLoading(true)
    setError(null)
    
    try {
      // Convert amount to smallest unit based on input token
      const amountInLamports = parseFloat(formData.amount) * 1e9 // Assuming SOL for now
      
      const response = await fetch('/api/trade/compare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputMint: formData.inputMint,
          outputMint: formData.outputMint,
          amount: amountInLamports.toString(),
          slippageBps: formData.slippageBps,
          userPublicKey
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || `HTTP ${response.status}`)
      }

      const data = await response.json()
      setComparison(data)
    } catch (err) {
      console.error('❌ Trade comparison error:', err)
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [formData, userPublicKey])

  const handlePoolsTest = useCallback(async () => {
    setPoolsLoading(true)
    setError(null)
    
    try {
      const response = await fetch('/api/trade/pools-test?type=comprehensive&format=summary', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      setPoolsTestResults(data)
    } catch (err) {
      console.error('❌ Pools test error:', err)
      setError(err instanceof Error ? err.message : 'Pools test failed')
    } finally {
      setPoolsLoading(false)
    }
  }, [])

  const formatAmount = (amount: string, decimals: number = 6): string => {
    const num = parseFloat(amount) / Math.pow(10, decimals)
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 })
  }

  const getProviderStatusColor = (quote: ProviderQuote): string => {
    if (!quote.success) return 'bg-red-100 border-red-300'
    if (comparison?.bestQuote?.provider === quote.provider) return 'bg-green-100 border-green-300'
    return 'bg-yellow-100 border-yellow-300'
  }

  const getProviderIcon = (provider: TradeProvider): string => {
    switch (provider) {
      case 'jupiter': return '🪐'
      case 'dflow': return '🌊'
      case 'dflow-intent': return '💎'
      case 'solana-tracker': return '📊'
      case 'gmgn': return '🔥'
      case 'pump-fun': return '🚀'
      default: return '❓'
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-800">Trade Quote Comparison</h2>
          <button
            onClick={() => setShowPoolsTest(!showPoolsTest)}
            className="bg-purple-600 text-white px-4 py-2 rounded-md hover:bg-purple-700 transition-colors text-sm"
          >
            {showPoolsTest ? '🔄 Individual Tests' : '🧪 Jupiter Pools Test'}
          </button>
        </div>
        
        {/* Jupiter Pools Test UI */}
        {showPoolsTest ? (
          <div className="space-y-6">
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
              <h3 className="text-lg font-bold text-purple-800 mb-3">🧪 Jupiter Pools Test</h3>
              <p className="text-purple-700 mb-4">
                Test real Jupiter pools for buy/sell operations across all providers to find the fastest and best rates.
              </p>
              <button
                onClick={handlePoolsTest}
                disabled={poolsLoading || !userPublicKey}
                className="bg-purple-600 text-white py-3 px-6 rounded-md hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {poolsLoading ? '🔄 Testing 5 Real Pools...' : '🚀 Run Jupiter Pools Test'}
              </button>
            </div>
            
            {/* Pools Test Results */}
            {poolsTestResults && (
              <div className="space-y-4">
                {/* Quick Stats */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                    <h4 className="font-bold text-green-800 mb-1">🏆 Fastest Provider</h4>
                                         {(() => {
                       const fastest = Object.entries(poolsTestResults.summary.providerPerformance)
                         .reduce((fastest, [provider, stats]: [string, any]) => 
                           stats.avgResponseTime < (fastest[1] as any).avgResponseTime ? [provider, stats] : fastest
                         )
                       return (
                         <div>
                           <p className="text-lg font-bold text-green-700">
                             {getProviderIcon(fastest[0] as any)} {fastest[0]}
                           </p>
                           <p className="text-sm text-green-600">{Math.round((fastest[1] as any).avgResponseTime)}ms avg</p>
                         </div>
                       )
                     })()}
                  </div>
                  
                  <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                    <h4 className="font-bold text-blue-800 mb-1">💰 Best Rate Provider</h4>
                                         {(() => {
                       const bestRate = Object.entries(poolsTestResults.summary.providerPerformance)
                         .reduce((best, [provider, stats]: [string, any]) => 
                           stats.successes > (best[1] as any).successes ? [provider, stats] : best
                         )
                       return (
                         <div>
                           <p className="text-lg font-bold text-blue-700">
                             {getProviderIcon(bestRate[0] as any)} {bestRate[0]}
                           </p>
                           <p className="text-sm text-blue-600">{(bestRate[1] as any).successes} successes</p>
                         </div>
                       )
                     })()}
                  </div>
                  
                  <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
                    <h4 className="font-bold text-orange-800 mb-1">📊 Success Rate</h4>
                    <p className="text-lg font-bold text-orange-700">
                      {Math.round(((poolsTestResults.summary.successfulBuyTests + poolsTestResults.summary.successfulSellTests) / (poolsTestResults.summary.totalPools * 2)) * 100)}%
                    </p>
                    <p className="text-sm text-orange-600">Overall success</p>
                  </div>
                  
                  <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
                    <h4 className="font-bold text-purple-800 mb-1">⚡ Avg Response</h4>
                    <p className="text-lg font-bold text-purple-700">
                      {poolsTestResults.summary.averageResponseTime}ms
                    </p>
                    <p className="text-sm text-purple-600">All providers</p>
                  </div>
                </div>
                
                {/* Pool Results Summary */}
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <h4 className="font-bold text-gray-800 mb-3">Pool Test Results</h4>
                  <div className="space-y-2">
                                         {poolsTestResults.poolResults.map((pool: any, index: number) => (
                      <div key={pool.poolId} className="flex justify-between items-center p-3 bg-gray-50 rounded-md">
                        <div>
                          <span className="font-bold">{pool.symbol}</span>
                          <span className="text-sm text-gray-600 ml-2">
                            (${pool.liquidity ? pool.liquidity.toLocaleString() : 'Unknown'} liquidity)
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <span className={`px-2 py-1 rounded-full text-xs font-bold ${
                            pool.buySuccess ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                          }`}>
                            BUY: {pool.buySuccess ? `✅ ${getProviderIcon(pool.bestBuyProvider)}` : '❌'}
                          </span>
                          <span className={`px-2 py-1 rounded-full text-xs font-bold ${
                            pool.sellSuccess ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                          }`}>
                            SELL: {pool.sellSuccess ? `✅ ${getProviderIcon(pool.bestSellProvider)}` : '❌'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Dev Page Link */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-center">
                  <p className="text-gray-600 mb-2">For detailed analysis and advanced testing features:</p>
                  <a
                    href="/dev/pools-test"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block bg-gray-700 text-white px-4 py-2 rounded-md hover:bg-gray-800 transition-colors"
                  >
                    🔧 Open Advanced Dev Tools
                  </a>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
          {/* Input Form */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Input Token
            </label>
            <select
              value={formData.inputMint}
              onChange={(e) => setFormData(prev => ({ ...prev, inputMint: e.target.value }))}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            >
              <option value={COMMON_TOKENS.SOL}>SOL</option>
              <option value={COMMON_TOKENS.USDC}>USDC</option>
              <option value={COMMON_TOKENS.USDT}>USDT</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Output Token
            </label>
            <select
              value={formData.outputMint}
              onChange={(e) => setFormData(prev => ({ ...prev, outputMint: e.target.value }))}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            >
              <option value={COMMON_TOKENS.USDC}>USDC</option>
              <option value={COMMON_TOKENS.SOL}>SOL</option>
              <option value={COMMON_TOKENS.USDT}>USDT</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Amount
            </label>
            <input
              type="number"
              value={formData.amount}
              onChange={(e) => setFormData(prev => ({ ...prev, amount: e.target.value }))}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              placeholder="Enter amount"
              min="0"
              step="0.001"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Slippage (bps)
            </label>
            <input
              type="number"
              value={formData.slippageBps}
              onChange={(e) => setFormData(prev => ({ ...prev, slippageBps: parseInt(e.target.value) }))}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              placeholder="100"
              min="0"
              max="10000"
            />
          </div>
        </div>

        <button
          onClick={handleCompareQuotes}
          disabled={loading || !userPublicKey}
          className="w-full bg-blue-600 text-white py-3 px-6 rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Comparing Quotes...' : 'Compare Quotes'}
        </button>

        {error && (
          <div className="mt-4 p-4 bg-red-100 border border-red-300 rounded-md">
            <p className="text-red-700">Error: {error}</p>
          </div>
        )}
        </>
        )}
      </div>

      {/* Results */}
      {comparison && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h3 className="text-xl font-bold mb-4 text-gray-800">Summary</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-blue-50 p-4 rounded-md">
                <p className="text-sm text-gray-600">Recommended Provider</p>
                <p className="text-lg font-bold text-blue-700">
                  {getProviderIcon(comparison.summary.recommendation)} {comparison.summary.recommendation}
                </p>
              </div>
              <div className="bg-green-50 p-4 rounded-md">
                <p className="text-sm text-gray-600">Best Price</p>
                <p className="text-lg font-bold text-green-700">
                  {getProviderIcon(comparison.comparison.bestPrice.provider)} {comparison.comparison.bestPrice.advantage}
                </p>
              </div>
              <div className="bg-purple-50 p-4 rounded-md">
                <p className="text-sm text-gray-600">Fastest Response</p>
                <p className="text-lg font-bold text-purple-700">
                  {getProviderIcon(comparison.comparison.fastestResponse.provider)} {comparison.comparison.fastestResponse.responseTime}ms
                </p>
              </div>
              <div className="bg-orange-50 p-4 rounded-md">
                <p className="text-sm text-gray-600">Successful Quotes</p>
                <p className="text-lg font-bold text-orange-700">
                  {comparison.summary.successfulQuotes}/{comparison.summary.totalProvidersQueried}
                </p>
              </div>
            </div>
          </div>

          {/* Provider Quotes */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h3 className="text-xl font-bold mb-4 text-gray-800">Provider Quotes</h3>
            <div className="space-y-4">
              {comparison.quotes.map((quote) => (
                <div
                  key={quote.provider}
                  className={`p-4 border-2 rounded-lg ${getProviderStatusColor(quote)}`}
                >
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h4 className="text-lg font-bold flex items-center gap-2">
                        {getProviderIcon(quote.provider)} 
                        {quote.provider.charAt(0).toUpperCase() + quote.provider.slice(1)}
                        {comparison.bestQuote?.provider === quote.provider && (
                          <span className="bg-green-500 text-white px-2 py-1 rounded-full text-xs">BEST</span>
                        )}
                      </h4>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-600">Response Time</p>
                      <p className="font-bold">{quote.responseTime}ms</p>
                    </div>
                  </div>

                  {quote.success ? (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <p className="text-sm text-gray-600">Output Amount</p>
                        <p className="font-bold text-lg">{formatAmount(quote.outAmount)}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Price Impact</p>
                        <p className="font-bold">{parseFloat(quote.priceImpactPct).toFixed(4)}%</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Route Length</p>
                        <p className="font-bold">{quote.route?.length || 0} hops</p>
                      </div>
                    </div>
                  ) : (
                    <div className="text-red-700">
                      <p className="font-medium">Failed to get quote</p>
                      <p className="text-sm">{quote.error}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Technical Details */}
          <div className="bg-gray-50 rounded-lg p-4">
            <details className="cursor-pointer">
              <summary className="font-medium text-gray-700 hover:text-gray-900">
                Technical Details & Raw Response
              </summary>
              <pre className="mt-2 text-xs bg-white p-4 rounded border overflow-auto">
                {JSON.stringify(comparison, null, 2)}
              </pre>
            </details>
          </div>
        </div>
      )}
    </div>
  )
} 