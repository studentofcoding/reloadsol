'use client'

import React, { useState, useEffect, useCallback } from 'react'

interface TrendingToken {
  token_symbol: string
  token_address: string
  price: number
  change_1h: number
  change_5m: number
  volume_1h: number
  mcap: number
  logo_url?: string
  organic_score: number
  last_updated?: number
  price_change?: number
  created_at?: number
}

interface TrendingResponse {
  tokens: TrendingToken[]
  cached: boolean
  cache_age: number
  expires_in: number
  refresh_type?: string
  last_updated?: number
}

interface MarketCapCategory {
  name: string
  min: number
  max: number
  color: string
  bgColor: string
}

const MARKET_CAP_CATEGORIES: MarketCapCategory[] = [
  { name: '0-50K', min: 0, max: 50000, color: 'text-red-400', bgColor: 'bg-red-900/20 border-red-600' },
  { name: '51K-200K', min: 50001, max: 200000, color: 'text-yellow-400', bgColor: 'bg-yellow-900/20 border-yellow-600' },
  { name: '200K-500K', min: 200001, max: 500000, color: 'text-blue-400', bgColor: 'bg-blue-900/20 border-blue-600' },
  { name: '>500K', min: 500001, max: 3000000, color: 'text-green-400', bgColor: 'bg-green-900/20 border-green-600' }
]

const LoadingSkeleton = () => (
  <div className="space-y-6 animate-pulse">
    {[...Array(3)].map((_, i) => (
      <div key={i} className="bg-gray-800 rounded-lg p-6">
        <div className="h-6 bg-gray-700 rounded w-1/3 mb-4"></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, j) => (
            <div key={j} className="h-32 bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    ))}
  </div>
)

export default function TrendingPoolsPage() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [password, setPassword] = useState('')
  const [trendingData, setTrendingData] = useState<TrendingResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [volumeFilter, setVolumeFilter] = useState<number>(0)
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [sortBy, setSortBy] = useState<'mcap' | 'volume' | 'score' | 'change'>('score')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  
  // New state for chart functionality
  const [selectedToken, setSelectedToken] = useState<TrendingToken | null>(null)
  const [showChart, setShowChart] = useState(false)

  const handleAuth = useCallback(() => {
    if (password === 'reloadsol' || password === 'jupiter-test') {
      setIsAuthenticated(true)
      setPassword('')
    } else {
      setError('Invalid password. Hint: reloadsol or jupiter-test')
    }
  }, [password])

  const fetchTrendingData = useCallback(async () => {
    setLoading(true)
    setError(null)
    
    try {
      console.log('🚀 Fetching trending pools data...')
      
      const response = await fetch('/api/trending', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      setTrendingData(data)
      
    } catch (err) {
      console.error('Fetch error:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch trending data')
    } finally {
      setLoading(false)
    }
  }, [])

  // Auto-fetch data on mount
  useEffect(() => {
    if (isAuthenticated) {
      fetchTrendingData()
    }
  }, [isAuthenticated, fetchTrendingData])

  // Handle DexScreener chart toggle
  const handleDexScreenerClick = useCallback((token: TrendingToken) => {
    if (selectedToken?.token_address === token.token_address && showChart) {
      // If same token is clicked and chart is showing, close it
      setShowChart(false)
      setSelectedToken(null)
    } else {
      // Show chart for the selected token
      setSelectedToken(token)
      setShowChart(true)
    }
  }, [selectedToken, showChart])

  // Helper functions
  const formatNumber = (num: number): string => {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(2)}K`
    }
    return num.toLocaleString()
  }

  const formatPrice = (price: number): string => {
    if (price < 0.001) {
      return price.toExponential(3)
    }
    return price.toFixed(6)
  }

  const formatPercentage = (value: number): string => {
    return `${(value * 100).toFixed(2)}%`
  }

  const getMarketCapCategory = (mcap: number): MarketCapCategory => {
    return MARKET_CAP_CATEGORIES.find(cat => mcap >= cat.min && mcap <= cat.max) || MARKET_CAP_CATEGORIES[0]
  }

  const calculateNetVolume = (token: TrendingToken): number => {
    // For this example, we'll use volume_1h as buy volume and estimate sell volume
    // In a real implementation, you'd need separate buy/sell volume data
    const buyVolume = token.volume_1h
    const sellVolume = buyVolume * (1 - Math.max(0, token.change_1h)) // Rough estimation
    return buyVolume - sellVolume
  }

  // Filter and sort tokens
  const filteredAndSortedTokens = React.useMemo(() => {
    if (!trendingData?.tokens) return []

    let filtered = trendingData.tokens.filter(token => {
      const netVolume = calculateNetVolume(token)
      const volumeMatch = netVolume >= volumeFilter
      
      if (selectedCategory === 'all') return volumeMatch
      
      const category = getMarketCapCategory(token.mcap)
      return volumeMatch && category.name === selectedCategory
    })

    // Sort tokens
    filtered.sort((a, b) => {
      let aValue: number, bValue: number
      
      switch (sortBy) {
        case 'mcap':
          aValue = a.mcap
          bValue = b.mcap
          break
        case 'volume':
          aValue = calculateNetVolume(a)
          bValue = calculateNetVolume(b)
          break
        case 'score':
          aValue = a.organic_score
          bValue = b.organic_score
          break
        case 'change':
          aValue = a.change_1h
          bValue = b.change_1h
          break
        default:
          aValue = a.organic_score
          bValue = b.organic_score
      }
      
      return sortOrder === 'desc' ? bValue - aValue : aValue - bValue
    })

    return filtered
  }, [trendingData, volumeFilter, selectedCategory, sortBy, sortOrder])

  // Group tokens by market cap category
  const tokensByCategory = React.useMemo(() => {
    const grouped: Record<string, TrendingToken[]> = {}
    
    MARKET_CAP_CATEGORIES.forEach(category => {
      grouped[category.name] = []
    })
    
    filteredAndSortedTokens.forEach(token => {
      const category = getMarketCapCategory(token.mcap)
      grouped[category.name].push(token)
    })
    
    return grouped
  }, [filteredAndSortedTokens])

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-black py-8">
        <div className="container mx-auto px-4">
          <div className="max-w-md mx-auto">
            <div className="bg-white p-8 rounded-lg shadow-lg">
              <h1 className="text-2xl font-bold mb-6 text-center text-red-600">🔒 Developer Access Required</h1>
              <p className="text-gray-600 mb-4 text-center">
                This page displays trending pool data and is restricted to developers only.
              </p>
              <div className="space-y-4">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleAuth()}
                  placeholder="Enter developer password"
                  className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleAuth}
                  className="w-full bg-blue-600 text-white py-3 px-6 rounded-md hover:bg-blue-700 transition-colors"
                >
                  Access Trending Pools
                </button>
                {error && (
                  <div className="p-3 bg-red-100 border border-red-300 rounded-md text-red-700 text-sm">
                    {error}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-black py-8">
      <div className="container mx-auto px-4">
        <div className={`max-w-7xl mx-auto space-y-6 ${showChart ? 'flex gap-6' : ''}`}>
          {/* Main Content */}
          <div className={`${showChart ? 'flex-1' : 'w-full'} space-y-6`}>
            {/* Header */}
            <div className="text-center mb-8">
              <h1 className="text-5xl font-bold text-white mb-4">
                📊 Trending Pools Dashboard
              </h1>
              <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
                Real-time trending pool data with market cap categories and volume filtering
              </h2>
              <div className="mt-6 flex justify-center gap-4">
                <button
                  onClick={fetchTrendingData}
                  disabled={loading}
                  className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:bg-gray-600 transition-colors font-semibold"
                >
                  {loading ? '🔄 Loading...' : '🔄 Refresh Data'}
                </button>
                <button
                  onClick={() => setIsAuthenticated(false)}
                  className="bg-red-500 text-white px-6 py-3 rounded-lg hover:bg-red-600 transition-colors font-semibold"
                >
                  Logout
                </button>
                {showChart && (
                  <button
                    onClick={() => {
                      setShowChart(false)
                      setSelectedToken(null)
                    }}
                    className="bg-gray-600 text-white px-6 py-3 rounded-lg hover:bg-gray-700 transition-colors font-semibold"
                  >
                    ✕ Close Chart
                  </button>
                )}
              </div>
            </div>

            {/* Controls */}
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4 text-white">Filters & Controls</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Volume Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Min Net Volume</label>
                  <input
                    type="number"
                    value={volumeFilter}
                    onChange={(e) => setVolumeFilter(Number(e.target.value))}
                    placeholder="0"
                    className="w-full p-3 bg-gray-800 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                
                {/* Category Filter */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Market Cap Category</label>
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="w-full p-3 bg-gray-800 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="all">All Categories</option>
                    {MARKET_CAP_CATEGORIES.map(cat => (
                      <option key={cat.name} value={cat.name}>{cat.name}</option>
                    ))}
                  </select>
                </div>
                
                {/* Sort By */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Sort By</label>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="w-full p-3 bg-gray-800 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="score">Organic Score</option>
                    <option value="mcap">Market Cap</option>
                    <option value="volume">Net Volume</option>
                    <option value="change">1H Change</option>
                  </select>
                </div>
                
                {/* Sort Order */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Sort Order</label>
                  <select
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value as any)}
                    className="w-full p-3 bg-gray-800 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="desc">Descending</option>
                    <option value="asc">Ascending</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Stats Summary */}
            {trendingData && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-gray-900 border border-gray-700 p-6 rounded-lg">
                  <h3 className="text-lg font-bold text-white mb-2">📊 Total Tokens</h3>
                  <p className="text-3xl font-bold text-blue-400">{trendingData.tokens.length}</p>
                  <p className="text-sm text-gray-400">Filtered: {filteredAndSortedTokens.length}</p>
                </div>
                
                <div className="bg-gray-900 border border-gray-700 p-6 rounded-lg">
                  <h3 className="text-lg font-bold text-white mb-2">💰 Avg Market Cap</h3>
                  <p className="text-3xl font-bold text-green-400">
                    ${formatNumber(filteredAndSortedTokens.reduce((sum, t) => sum + t.mcap, 0) / Math.max(1, filteredAndSortedTokens.length))}
                  </p>
                  <p className="text-sm text-gray-400">Across filtered tokens</p>
                </div>
                
                <div className="bg-gray-900 border border-gray-700 p-6 rounded-lg">
                  <h3 className="text-lg font-bold text-white mb-2">📈 Avg Score</h3>
                  <p className="text-3xl font-bold text-yellow-400">
                    {(filteredAndSortedTokens.reduce((sum, t) => sum + t.organic_score, 0) / Math.max(1, filteredAndSortedTokens.length)).toFixed(1)}
                  </p>
                  <p className="text-sm text-gray-400">Organic score</p>
                </div>
                
                <div className="bg-gray-900 border border-gray-700 p-6 rounded-lg">
                  <h3 className="text-lg font-bold text-white mb-2">⏱️ Cache Status</h3>
                  <p className="text-lg font-bold text-purple-400">
                    {trendingData.cached ? 'Cached' : 'Fresh'}
                  </p>
                  <p className="text-sm text-gray-400">
                    {trendingData.cached ? `Age: ${trendingData.cache_age}s` : 'Just updated'}
                  </p>
                </div>
              </div>
            )}

            {/* Error Display */}
            {error && (
              <div className="bg-red-900 border border-red-600 rounded-lg p-6">
                <h3 className="text-lg font-bold text-red-200 mb-2">❌ Error</h3>
                <p className="text-red-300">{error}</p>
              </div>
            )}

            {/* Loading State */}
            {loading && <LoadingSkeleton />}

            {/* Market Cap Categories */}
            {!loading && trendingData && (
              <div className="space-y-6">
                {MARKET_CAP_CATEGORIES.map(category => {
                  const categoryTokens = tokensByCategory[category.name] || []
                  if (categoryTokens.length === 0 && selectedCategory !== 'all') return null
                  
                  return (
                    <div key={category.name} className={`border-2 rounded-lg p-6 ${category.bgColor}`}>
                      <div className="flex justify-between items-center mb-4">
                        <h2 className={`text-2xl font-bold ${category.color}`}>
                          💎 {category.name} Market Cap ({categoryTokens.length} tokens)
                        </h2>
                        <div className="text-sm text-gray-400">
                          Range: ${formatNumber(category.min)} - {category.max === Infinity ? '∞' : `$${formatNumber(category.max)}`}
                        </div>
                      </div>
                      
                      {categoryTokens.length === 0 ? (
                        <p className="text-gray-400 text-center py-8">No tokens in this category match your filters</p>
                      ) : (
                        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                          {categoryTokens.map(token => {
                            const netVolume = calculateNetVolume(token)
                            const createdDate = token.created_at ? new Date(token.created_at * 1000) : null
                            const isSelected = selectedToken?.token_address === token.token_address
                            
                            return (
                              <div key={token.token_address} className={`bg-gray-800 border rounded-lg p-4 hover:border-gray-500 transition-colors ${
                                isSelected ? 'border-green-500 ring-2 ring-green-500/20' : 'border-gray-600'
                              }`}>
                                {/* Token Header */}
                                <div className="flex items-center gap-3 mb-3">
                                  {token.logo_url && (
                                    <img 
                                      src={token.logo_url} 
                                      alt={token.token_symbol}
                                      className="w-10 h-10 rounded-full"
                                      onError={(e) => {
                                        e.currentTarget.style.display = 'none'
                                      }}
                                    />
                                  )}
                                  <div>
                                    <h3 className="text-lg font-bold text-white">{token.token_symbol}</h3>
                                    <p className="text-xs text-gray-400 font-mono">
                                      {token.token_address.slice(0, 8)}...{token.token_address.slice(-8)}
                                    </p>
                                  </div>
                                </div>
                                
                                {/* Token Stats */}
                                <div className="space-y-2 text-sm">
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">Price:</span>
                                    <span className="text-white font-mono">${formatPrice(token.price)}</span>
                                  </div>
                                  
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">Market Cap:</span>
                                    <span className={`font-bold ${category.color}`}>${formatNumber(token.mcap)}</span>
                                  </div>
                                  
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">1H Change:</span>
                                    <span className={`font-bold ${
                                      token.change_1h > 0 ? 'text-green-400' : 
                                      token.change_1h < 0 ? 'text-red-400' : 'text-gray-400'
                                    }`}>
                                      {formatPercentage(token.change_1h)}
                                    </span>
                                  </div>
                                  
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">5M Change:</span>
                                    <span className={`font-bold ${
                                      token.change_5m > 0 ? 'text-green-400' : 
                                      token.change_5m < 0 ? 'text-red-400' : 'text-gray-400'
                                    }`}>
                                      {formatPercentage(token.change_5m)}
                                    </span>
                                  </div>
                                  
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">1H Volume:</span>
                                    <span className="text-blue-400 font-bold">${formatNumber(token.volume_1h)}</span>
                                  </div>
                                  
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">Net Volume:</span>
                                    <span className={`font-bold ${
                                      netVolume > 0 ? 'text-green-400' : 
                                      netVolume < 0 ? 'text-red-400' : 'text-gray-400'
                                    }`}>
                                      ${formatNumber(Math.abs(netVolume))} {netVolume >= 0 ? '(Buy)' : '(Sell)'}
                                    </span>
                                  </div>
                                  
                                  <div className="flex justify-between">
                                    <span className="text-gray-400">Organic Score:</span>
                                    <span className="text-yellow-400 font-bold">{token.organic_score.toFixed(1)}</span>
                                  </div>
                                  
                                  {createdDate && (
                                    <div className="flex justify-between">
                                      <span className="text-gray-400">Created:</span>
                                      <span className="text-purple-400 text-xs">
                                        {createdDate.toLocaleDateString()}
                                      </span>
                                    </div>
                                  )}
                                  
                                  {token.last_updated && (
                                    <div className="flex justify-between">
                                      <span className="text-gray-400">Updated:</span>
                                      <span className="text-gray-500 text-xs">
                                        {Math.round((Date.now() - token.last_updated) / 1000)}s ago
                                      </span>
                                    </div>
                                  )}
                                </div>
                                
                                {/* Action Buttons */}
                                <div className="mt-4 flex gap-2">
                                  <button 
                                    onClick={() => window.open(`https://solscan.io/token/${token.token_address}`, '_blank')}
                                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs py-2 px-3 rounded transition-colors"
                                  >
                                    📊 Solscan
                                  </button>
                                  <button 
                                    onClick={() => handleDexScreenerClick(token)}
                                    className={`flex-1 text-white text-xs py-2 px-3 rounded transition-colors ${
                                      isSelected && showChart 
                                        ? 'bg-red-600 hover:bg-red-700' 
                                        : 'bg-green-600 hover:bg-green-700'
                                    }`}
                                  >
                                    {isSelected && showChart ? '✕ Close Chart' : '📈 DexScreener'}
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Raw Data */}
            {trendingData && (
              <div className="bg-gray-900 border border-gray-700 rounded-lg p-6">
                <details className="cursor-pointer">
                  <summary className="font-medium text-gray-300 hover:text-white">
                    🔍 Raw API Response (JSON)
                  </summary>
                  <pre className="mt-4 text-xs bg-gray-800 text-gray-300 p-4 rounded border border-gray-600 overflow-auto max-h-96">
                    {JSON.stringify(trendingData, null, 2)}
                  </pre>
                </details>
              </div>
            )}
          </div>

          {/* Chart Panel */}
          {showChart && selectedToken && (
            <div className="w-96 bg-gray-900 border border-gray-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  {selectedToken.logo_url && (
                    <img 
                      src={selectedToken.logo_url} 
                      alt={selectedToken.token_symbol}
                      className="w-8 h-8 rounded-full"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  )}
                  <div>
                    <h3 className="text-lg font-bold text-white">{selectedToken.token_symbol}</h3>
                    <p className="text-xs text-gray-400">${formatPrice(selectedToken.price)}</p>
                    {/* Tooltip for mint address */}
                    <div className="group relative">
                      <p className="text-xs text-gray-500 cursor-help font-mono truncate max-w-[200px]">
                        {selectedToken.token_address.slice(0, 8)}...{selectedToken.token_address.slice(-8)}
                      </p>
                      <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-50">
                        <div className="bg-black text-white text-xs rounded py-2 px-3 whitespace-nowrap border border-gray-600 shadow-lg">
                          <div className="font-semibold mb-1">Mint Address:</div>
                          <div className="font-mono break-all">{selectedToken.token_address}</div>
                          <div className="absolute top-full left-4 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-black"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setShowChart(false)
                    setSelectedToken(null)
                  }}
                  className="text-gray-400 hover:text-white transition-colors"
                >
                  ✕
                </button>
              </div>
              
              {/* GMGN Chart */}
              <div className="bg-gray-800 rounded-lg overflow-hidden">
                <iframe
                  src={`https://www.gmgn.cc/kline/sol/${selectedToken.token_address}?interval=1D`}
                  width="100%"
                  height="600"
                  frameBorder="0"
                  className="w-full"
                  title={`${selectedToken.token_symbol} Chart`}
                  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  loading="lazy"
                />
              </div>
              
              {/* Fallback message if chart doesn't load */}
              <div className="mt-2 text-xs text-gray-500 text-center">
                If chart doesn't load, try the external links below
              </div>
              
              {/* Quick Actions */}
              <div className="mt-4 flex gap-2">
                <button 
                  onClick={() => window.open(`https://gmgn.ai/sol/token/${selectedToken.token_address}`, '_blank')}
                  className="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-sm py-2 px-3 rounded transition-colors"
                >
                  🚀 GMGN
                </button>
                <button 
                  onClick={() => window.open(`https://dexscreener.com/solana/${selectedToken.token_address}`, '_blank')}
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm py-2 px-3 rounded transition-colors"
                >
                  📈 DexScreener
                </button>
                <button 
                  onClick={() => window.open(`https://solscan.io/token/${selectedToken.token_address}`, '_blank')}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm py-2 px-3 rounded transition-colors"
                >
                  📊 Solscan
                </button>
              </div>
              
              {/* Copy mint address button */}
              <div className="mt-3">
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(selectedToken.token_address)
                    // You could add a toast notification here
                  }}
                  className="w-full bg-gray-700 hover:bg-gray-600 text-white text-xs py-2 px-3 rounded transition-colors"
                >
                  📋 Copy Mint Address
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}