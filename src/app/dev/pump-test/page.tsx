'use client'

import { useState } from 'react'
import { TradeComparison } from '@/types'

// Pump.fun specific token addresses for testing
const PUMP_TOKENS = [
  {
    address: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump',
    symbol: 'GOAT',
    name: 'Goatseus Maximus'
  },
  {
    address: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
    symbol: 'FWOG',
    name: 'FWOG'
  },
  {
    address: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
    symbol: 'MOODENG',
    name: 'Moo Deng'
  }
]

export default function PumpTestPage() {
  const [selectedToken, setSelectedToken] = useState(PUMP_TOKENS[0])
  const [amount, setAmount] = useState('0.1')
  const [comparison, setComparison] = useState<TradeComparison | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [healthStatus, setHealthStatus] = useState<Record<string, boolean>>({})

  const testPumpfunQuote = async () => {
    setLoading(true)
    setError(null)
    
    try {
      const amountInLamports = parseFloat(amount) * 1e9
      
      const response = await fetch('/api/trade/compare', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputMint: 'So11111111111111111111111111111111111111112', // SOL
          outputMint: selectedToken.address,
          amount: amountInLamports.toString(),
          slippageBps: 100, // 1%
          userPublicKey: '11111111111111111111111111111111' // Dummy key for testing
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || `HTTP ${response.status}`)
      }

      const data = await response.json()
      setComparison(data)
    } catch (err) {
      console.error('❌ Pump.fun test error:', err)
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  const checkHealth = async () => {
    try {
      const response = await fetch('/api/trade/health')
      const data = await response.json()
      setHealthStatus(data)
    } catch (err) {
      console.error('Health check failed:', err)
    }
  }

  const formatAmount = (amount: string, decimals: number = 6): string => {
    const num = parseFloat(amount) / Math.pow(10, decimals)
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 })
  }

  const getProviderIcon = (provider: string): string => {
    switch (provider) {
      case 'jupiter': return '🪐'
      case 'dflow': return '🌊'
      case 'solana-tracker': return '📊'
      case 'gmgn': return '🔥'
      case 'pump-fun': return '🚀'
      default: return '❓'
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <h1 className="text-3xl font-bold mb-4 text-gray-800">
          🚀 Pump.fun Integration Test
        </h1>
        <p className="text-gray-600 mb-6">
          Test pump.fun RPC integration with the Helius endpoint for trading pump.fun tokens.
        </p>

        {/* Health Check */}
        <div className="mb-6">
          <button
            onClick={checkHealth}
            className="bg-purple-600 text-white px-4 py-2 rounded-md hover:bg-purple-700 transition-colors"
          >
            🏥 Check Provider Health
          </button>
          
          {Object.keys(healthStatus).length > 0 && (
            <div className="mt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
              {Object.entries(healthStatus).map(([provider, isHealthy]) => (
                <div
                  key={provider}
                  className={`p-2 rounded-md text-center ${
                    isHealthy ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}
                >
                  <div className="font-bold">
                    {getProviderIcon(provider)} {provider}
                  </div>
                  <div className="text-sm">
                    {isHealthy ? '✅ Healthy' : '❌ Down'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Test Configuration */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Pump.fun Token
            </label>
            <select
              value={selectedToken.address}
              onChange={(e) => {
                const token = PUMP_TOKENS.find(t => t.address === e.target.value)
                if (token) setSelectedToken(token)
              }}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
            >
              {PUMP_TOKENS.map(token => (
                <option key={token.address} value={token.address}>
                  {token.symbol} - {token.name}
                </option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              SOL Amount
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
              placeholder="0.1"
              min="0.01"
              step="0.01"
            />
          </div>

          <div className="flex items-end">
            <button
              onClick={testPumpfunQuote}
              disabled={loading}
              className="w-full bg-purple-600 text-white py-3 px-6 rounded-md hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? '🔄 Testing...' : '🚀 Test Pump.fun Quote'}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-100 border border-red-300 rounded-md">
            <p className="text-red-700">Error: {error}</p>
          </div>
        )}
      </div>

      {/* Results */}
      {comparison && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h3 className="text-xl font-bold mb-4 text-gray-800">Test Results Summary</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-purple-50 p-4 rounded-md">
                <p className="text-sm text-gray-600">Pump.fun Status</p>
                <p className="text-lg font-bold text-purple-700">
                  {comparison.quotes.find(q => q.provider === 'pump-fun')?.success ? '✅ Success' : '❌ Failed'}
                </p>
              </div>
              <div className="bg-blue-50 p-4 rounded-md">
                <p className="text-sm text-gray-600">Best Provider</p>
                <p className="text-lg font-bold text-blue-700">
                  {getProviderIcon(comparison.summary.recommendation)} {comparison.summary.recommendation}
                </p>
              </div>
              <div className="bg-green-50 p-4 rounded-md">
                <p className="text-sm text-gray-600">Successful Quotes</p>
                <p className="text-lg font-bold text-green-700">
                  {comparison.summary.successfulQuotes}/{comparison.summary.totalProvidersQueried}
                </p>
              </div>
              <div className="bg-orange-50 p-4 rounded-md">
                <p className="text-sm text-gray-600">Avg Response Time</p>
                <p className="text-lg font-bold text-orange-700">
                  {comparison.summary.averageResponseTime}ms
                </p>
              </div>
            </div>
          </div>

          {/* Provider Results */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h3 className="text-xl font-bold mb-4 text-gray-800">Provider Comparison</h3>
            <div className="space-y-4">
              {comparison.quotes.map((quote) => (
                <div
                  key={quote.provider}
                  className={`p-4 border-2 rounded-lg ${
                    quote.success 
                      ? quote.provider === 'pump-fun' 
                        ? 'bg-purple-50 border-purple-300' 
                        : 'bg-green-50 border-green-300'
                      : 'bg-red-50 border-red-300'
                  }`}
                >
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h4 className="text-lg font-bold flex items-center gap-2">
                        {getProviderIcon(quote.provider)} 
                        {quote.provider.charAt(0).toUpperCase() + quote.provider.slice(1)}
                        {quote.provider === 'pump-fun' && (
                          <span className="bg-purple-500 text-white px-2 py-1 rounded-full text-xs">PUMP.FUN</span>
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
                        <p className="text-sm text-gray-600">Route</p>
                        <p className="font-bold">
                          {quote.provider === 'pump-fun' ? '🚀 Bonding Curve' : `${quote.route?.length || 0} hops`}
                        </p>
                      </div>
                      
                      {/* Pump.fun specific data */}
                      {quote.provider === 'pump-fun' && quote.providerData?.['pump-fun'] && (
                        <div className="md:col-span-3 mt-2 p-3 bg-purple-100 rounded-md">
                          <h5 className="font-bold text-purple-800 mb-2">🚀 Pump.fun Details</h5>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                            <div>
                              <span className="text-purple-600">Market Price:</span>
                              <span className="font-bold ml-1">
                                ${quote.providerData['pump-fun'].marketPrice?.toFixed(8) || 'N/A'}
                              </span>
                            </div>
                            <div>
                              <span className="text-purple-600">Liquidity USD:</span>
                              <span className="font-bold ml-1">
                                ${quote.providerData['pump-fun'].liquidityUsd?.toLocaleString() || 'N/A'}
                              </span>
                            </div>
                            <div>
                              <span className="text-purple-600">RPC:</span>
                              <span className="font-bold ml-1 text-xs">Helius</span>
                            </div>
                          </div>
                        </div>
                      )}
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

          {/* Raw Data */}
          <div className="bg-gray-50 rounded-lg p-4">
            <details className="cursor-pointer">
              <summary className="font-medium text-gray-700 hover:text-gray-900">
                🔍 Raw Pump.fun Data & Full Response
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