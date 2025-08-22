'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'

interface McapTrackingData {
  token_address: string
  token_symbol: string
  first_mcap: number
  current_mcap: number
  first_seen_at: string
  last_updated_at: string
  mcap_growth_percent: number
  when_reach_80mc: string | null
  when_reach_120mc: string | null
  when_reach_200mc: string | null
  solPerToken: {
    first: number
    current: number
    growth: number
  }
}

interface FilterOptions {
  search: string
  sortBy: string
  sortOrder: 'asc' | 'desc'
  minGrowth: string
  maxGrowth: string
  minMcap: string
  maxMcap: string
  excludeZeroPnl: boolean
}

interface ApiResponse {
  success: boolean
  data: McapTrackingData[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
  stats: {
    total: number
    gainers: number
    losers: number
    zeroPercent: number
    zeroPercentage: number
    avgGrowth: number
    avgGrowthAll: number
    avgGrowthExcludingZero: number
    totalMcap: number
    solPriceUSD: number
    mcapRangeAnalysis: {
      under50k: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
      under200k: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
      under1M: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
    }
    thirtyDaysSummary: {
      totalTokensAdded: number
      avgDailyGrowth: number
      dailyBreakdown: Array<{
        date: string
        tokensAdded: number
        avgGrowth: number
        totalMcap: number
        gainers: number
        losers: number
      }>
    }
  }
  error: string
}

const LoadingSkeleton = () => (
  <div className="animate-pulse space-y-4">
    {[...Array(5)].map((_, i) => (
      <div key={i} className="bg-gray-800 rounded-lg p-4 h-32"></div>
    ))}
  </div>
)

export default function McapTrackerPage() {
  const [tokens, setTokens] = useState<McapTrackingData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [stats, setStats] = useState<ApiResponse['stats'] | null>(null)
  const [expandedChart, setExpandedChart] = useState<string | null>(null)
  const [isChartLoading, setIsChartLoading] = useState(false)
  const [refetchingTokens, setRefetchingTokens] = useState<Set<string>>(new Set())
  
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0
  })
  
  const [filters, setFilters] = useState<FilterOptions>({
    search: '',
    sortBy: 'last_updated_at',
    sortOrder: 'desc',
    minGrowth: '',
    maxGrowth: '',
    minMcap: '',
    maxMcap: '',
    excludeZeroPnl: false
  })

  const fetchTokens = useCallback(async (page = 1) => {
    setLoading(true)
    setError('')
    
    try {
      const params = new URLSearchParams({
        action: 'list',
        page: page.toString(),
        limit: pagination.limit.toString(),
        sortBy: filters.sortBy,
        sortOrder: filters.sortOrder,
        excludeZeroPnl: filters.excludeZeroPnl.toString()
      })
      
      if (filters.search) params.append('search', filters.search)
      if (filters.minGrowth) params.append('minGrowth', filters.minGrowth)
      if (filters.maxGrowth) params.append('maxGrowth', filters.maxGrowth)
      if (filters.minMcap) params.append('minMcap', filters.minMcap)
      if (filters.maxMcap) params.append('maxMcap', filters.maxMcap)
      
      const response = await fetch(`/api/mcap-tracking?${params}`)
      const data: ApiResponse = await response.json()
      
      if (data.success) {
        setTokens(data.data)
        setPagination(data.pagination)
        setStats(data.stats)
      } else {
        setError(data.error || 'Failed to fetch data')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [filters, pagination.limit])

  useEffect(() => {
    fetchTokens(1)
  }, [filters])

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTokens(pagination.page)
    }, 30000) // Refresh every 30 seconds
    
    return () => clearInterval(interval)
  }, [fetchTokens, pagination.page])

  // Utility functions
  const formatNumber = (num: number): string => {
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`
    if (num >= 1e3) return `$${(num / 1e3).toFixed(0)}K`
    return `$${num.toFixed(0)}`
  }

  const formatSolAmount = (solAmount: number): string => {
    if (solAmount >= 1000) return `${(solAmount / 1000).toFixed(2)}K SOL`
    if (solAmount >= 1) return `${solAmount.toFixed(2)} SOL`
    return `${solAmount.toFixed(4)} SOL`
  }

  const formatPercentage = (percent: number): string => {
    return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`
  }

  const getGrowthColor = (percent: number): string => {
    if (Math.abs(percent) < 0.01) return 'text-gray-400'
    return percent >= 0 ? 'text-green-400' : 'text-red-400'
  }

  const getGrowthIcon = (percent: number): string => {
    if (Math.abs(percent) < 0.01) return '➖'
    return percent >= 0 ? '📈' : '📉'
  }

  const handleChartToggle = async (tokenAddress: string) => {
    if (expandedChart === tokenAddress) {
      setExpandedChart(null)
      setIsChartLoading(false)
    } else {
      setExpandedChart(tokenAddress)
      setIsChartLoading(true)
      
      // Refetch current MCap data when opening chart
      await refetchTokenMcap(tokenAddress)
    }
  }

  const refetchTokenMcap = async (tokenAddress: string) => {
    if (refetchingTokens.has(tokenAddress)) return
    
    setRefetchingTokens(prev => new Set(prev).add(tokenAddress))
    
    try {
      const response = await fetch(`/api/mcap-tracking?action=refetch&token=${tokenAddress}`)
      const data = await response.json()
      
      if (data.success) {
        // Update the token in the current list with new data
        setTokens(prevTokens => 
          prevTokens.map(token => {
            if (token.token_address === tokenAddress) {
              const solPriceUSD = stats?.solPriceUSD || 1
              return {
                ...token,
                current_mcap: data.currentMcap,
                mcap_growth_percent: data.tracking.growthPercent || token.mcap_growth_percent,
                last_updated_at: new Date().toISOString(),
                solPerToken: {
                  first: token.first_mcap / solPriceUSD,
                  current: data.currentMcap / solPriceUSD,
                  growth: ((data.currentMcap / solPriceUSD) - (token.first_mcap / solPriceUSD)) / (token.first_mcap / solPriceUSD) * 100
                }
              }
            }
            return token
          })
        )
        
        // Refresh the full data to update stats
        await fetchTokens(pagination.page)
        
        console.log(`MCap refetched for ${tokenAddress}:`, data.display)
      } else {
        console.error('Failed to refetch MCap:', data.error)
      }
    } catch (error) {
      console.error('Error refetching MCap:', error)
    } finally {
      setRefetchingTokens(prev => {
        const newSet = new Set(prev)
        newSet.delete(tokenAddress)
        return newSet
      })
    }
  }

  const exportToCSV = () => {
    const headers = [
      'Symbol', 'Address', 'First MCap', 'Current MCap', 'Growth %', 
      'First SOL', 'Current SOL', 'SOL Growth %', 'First Seen', 'Last Updated'
    ]
    
    const csvData = tokens.map(token => [
      token.token_symbol,
      token.token_address,
      token.first_mcap,
      token.current_mcap,
      token.mcap_growth_percent,
      token.solPerToken.first,
      token.solPerToken.current,
      token.solPerToken.growth,
      token.first_seen_at,
      token.last_updated_at
    ])
    
    const csvContent = [headers, ...csvData]
      .map(row => row.map(cell => `"${cell}"`).join(','))
      .join('\n')
    
    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mcap-tracking-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading && tokens.length === 0) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">MCap Tracker</h1>
            <p className="text-gray-400">Loading market cap tracking data...</p>
          </div>
          <LoadingSkeleton />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">MCap Tracker</h1>
          <p className="text-gray-400">
            Monitor token market cap changes and growth patterns over time
          </p>
          {stats && (
            <p className="text-sm text-blue-400 mt-2">
              SOL Price: ${stats.solPriceUSD.toFixed(2)}
            </p>
          )}
        </div>

        {/* Enhanced Statistics Overview */}
        {stats && (
          <>
            {/* Main Stats */}
            <div className="grid grid-cols-1 md:grid-cols-6 gap-4 mb-8">
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="text-2xl font-bold text-blue-400">{stats.total.toLocaleString()}</div>
                <div className="text-sm text-gray-400">Total Tokens</div>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="text-2xl font-bold text-green-400">{stats.gainers.toLocaleString()}</div>
                <div className="text-sm text-gray-400">Gainers</div>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="text-2xl font-bold text-red-400">{stats.losers.toLocaleString()}</div>
                <div className="text-sm text-gray-400">Losers</div>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="text-2xl font-bold text-gray-400">{stats.zeroPercent.toLocaleString()}</div>
                <div className="text-sm text-gray-400">0% PnL ({stats.zeroPercentage.toFixed(1)}%)</div>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <div className={`text-2xl font-bold ${getGrowthColor(stats.avgGrowth)}`}>
                  {formatPercentage(stats.avgGrowth)}
                </div>
                <div className="text-sm text-gray-400">Avg Growth</div>
              </div>
              <div className="bg-gray-800 rounded-lg p-4">
                <div className="text-2xl font-bold text-purple-400">{formatNumber(stats.totalMcap)}</div>
                <div className="text-sm text-gray-400">Total MCap</div>
              </div>
            </div>

            {/* MCap Range Analysis */}
            <div className="bg-gray-800 rounded-lg p-6 mb-8">
              <h3 className="text-xl font-bold mb-4">MCap Range Analysis</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-gray-700 rounded-lg p-4">
                  <h4 className="text-lg font-semibold text-blue-400 mb-2">&lt;50K MCap</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Count:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.under50k.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Multiplier:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.under50k.avgMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Max Drawdown:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.under50k.maxDrawdown)}>
                        {formatPercentage(stats.mcapRangeAnalysis.under50k.maxDrawdown)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Growth:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.under50k.avgGrowth)}>
                        {formatPercentage(stats.mcapRangeAnalysis.under50k.avgGrowth)}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="bg-gray-700 rounded-lg p-4">
                  <h4 className="text-lg font-semibold text-green-400 mb-2">&lt;200K MCap</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Count:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.under200k.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Multiplier:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.under200k.avgMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Max Drawdown:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.under200k.maxDrawdown)}>
                        {formatPercentage(stats.mcapRangeAnalysis.under200k.maxDrawdown)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Growth:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.under200k.avgGrowth)}>
                        {formatPercentage(stats.mcapRangeAnalysis.under200k.avgGrowth)}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="bg-gray-700 rounded-lg p-4">
                  <h4 className="text-lg font-semibold text-purple-400 mb-2">&lt;1M MCap</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Count:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.under1M.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Multiplier:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.under1M.avgMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Max Drawdown:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.under1M.maxDrawdown)}>
                        {formatPercentage(stats.mcapRangeAnalysis.under1M.maxDrawdown)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Growth:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.under1M.avgGrowth)}>
                        {formatPercentage(stats.mcapRangeAnalysis.under1M.avgGrowth)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 30-Day Summary */}
            <div className="bg-gray-800 rounded-lg p-6 mb-8">
              <h3 className="text-xl font-bold mb-4">30-Day PnL Summary</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Tokens Added (30 days):</span>
                      <span className="text-white">{stats.thirtyDaysSummary.totalTokensAdded}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Daily Growth:</span>
                      <span className={getGrowthColor(stats.thirtyDaysSummary.avgDailyGrowth)}>
                        {formatPercentage(stats.thirtyDaysSummary.avgDailyGrowth)}
                      </span>
                    </div>
                  </div>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-gray-300 mb-2">Recent Daily Breakdown (Last 7 days)</h4>
                  <div className="space-y-1 text-xs">
                    {stats.thirtyDaysSummary.dailyBreakdown.slice(-7).map((day, index) => (
                      <div key={index} className="flex justify-between items-center">
                        <span className="text-gray-400">{day.date}:</span>
                        <div className="flex items-center space-x-2">
                          <span className="text-white">{day.tokensAdded} tokens</span>
                          <span className={getGrowthColor(day.avgGrowth)}>
                            {formatPercentage(day.avgGrowth)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Filters and Controls */}
        <div className="bg-gray-800 rounded-lg p-6 mb-8">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
            <h2 className="text-xl font-semibold">Filters & Search</h2>
            <div className="flex items-center space-x-2">
              <label className="flex items-center space-x-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.excludeZeroPnl}
                  onChange={(e) => setFilters(prev => ({ ...prev, excludeZeroPnl: e.target.checked }))}
                  className="rounded"
                />
                <span>Exclude 0% PnL from avg</span>
              </label>
              <button
                onClick={exportToCSV}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
              >
                Export CSV
              </button>
            </div>
          </div>
          
          {/* ... existing filter controls ... */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Search</label>
              <input
                type="text"
                placeholder="Symbol or address..."
                value={filters.search}
                onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Sort By</label>
              <select
                value={filters.sortBy}
                onChange={(e) => setFilters(prev => ({ ...prev, sortBy: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="last_updated_at">Last Updated</option>
                <option value="first_seen_at">First Seen</option>
                <option value="mcap_growth_percent">Growth %</option>
                <option value="current_mcap">Current MCap</option>
                <option value="first_mcap">First MCap</option>
                <option value="token_symbol">Symbol</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Order</label>
              <select
                value={filters.sortOrder}
                onChange={(e) => setFilters(prev => ({ ...prev, sortOrder: e.target.value as 'asc' | 'desc' }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
            <div>
              <label className="block text-sm font-medium mb-2">Min Growth %</label>
              <input
                type="number"
                placeholder="e.g., -50"
                value={filters.minGrowth}
                onChange={(e) => setFilters(prev => ({ ...prev, minGrowth: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Max Growth %</label>
              <input
                type="number"
                placeholder="e.g., 1000"
                value={filters.maxGrowth}
                onChange={(e) => setFilters(prev => ({ ...prev, maxGrowth: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Min MCap</label>
              <input
                type="number"
                placeholder="e.g., 50000"
                value={filters.minMcap}
                onChange={(e) => setFilters(prev => ({ ...prev, minMcap: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Max MCap</label>
              <input
                type="number"
                placeholder="e.g., 2000000"
                value={filters.maxMcap}
                onChange={(e) => setFilters(prev => ({ ...prev, maxMcap: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-900 border border-red-700 rounded-lg p-4 mb-8">
            <div className="text-red-200">Error: {error}</div>
          </div>
        )}

        {/* Token List */}
        <div className="space-y-4 mb-8">
          {loading && tokens.length > 0 && (
            <div className="text-center py-4">
              <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
              <span className="ml-2">Updating...</span>
            </div>
          )}
          
          {tokens.map((token) => (
            <div key={token.token_address} className="bg-gray-800 rounded-lg p-6 hover:bg-gray-750 transition-colors">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between">
                {/* Token Header */}
                <div className="flex items-center space-x-4 mb-4 lg:mb-0">
                  <div className="flex-shrink-0">
                    <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold text-lg">
                      {token.token_symbol.charAt(0)}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center space-x-2">
                      <h3 className="text-lg font-semibold text-white truncate">{token.token_symbol}</h3>
                      <span className={`text-2xl ${getGrowthColor(token.mcap_growth_percent)}`}>
                        {getGrowthIcon(token.mcap_growth_percent)}
                      </span>
                      <button
                        onClick={() => handleChartToggle(token.token_address)}
                        disabled={refetchingTokens.has(token.token_address)}
                        className={`px-2 py-1 text-white text-xs rounded transition-colors ${
                          refetchingTokens.has(token.token_address)
                            ? 'bg-yellow-600 hover:bg-yellow-700'
                            : 'bg-green-600 hover:bg-green-700'
                        }`}
                        title={refetchingTokens.has(token.token_address) ? 'Refetching MCap...' : 'Toggle Chart & Refetch MCap'}
                      >
                        {refetchingTokens.has(token.token_address) ? '🔄' : '📈'}
                      </button>
                    </div>
                    <p className="text-sm text-gray-400 font-mono truncate">{token.token_address}</p>
                  </div>
                </div>

                {/* Performance Metrics */}
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 lg:gap-6">
                  <div className="text-center lg:text-left">
                    <div className="text-sm text-gray-400">First MCap</div>
                    <div className="text-lg font-semibold text-white">{formatNumber(token.first_mcap)}</div>
                    <div className="text-xs text-blue-400">{formatSolAmount(token.solPerToken.first)}</div>
                  </div>
                  
                  <div className="text-center lg:text-left">
                    <div className="text-sm text-gray-400">Current MCap</div>
                    <div className="text-lg font-semibold text-white">{formatNumber(token.current_mcap)}</div>
                    <div className="text-xs text-blue-400">{formatSolAmount(token.solPerToken.current)}</div>
                  </div>
                  
                  <div className="text-center lg:text-left">
                    <div className="text-sm text-gray-400">USD Growth</div>
                    <div className={`text-lg font-semibold ${getGrowthColor(token.mcap_growth_percent)}`}>
                      {formatPercentage(token.mcap_growth_percent)}
                    </div>
                  </div>
                  
                  <div className="text-center lg:text-left">
                    <div className="text-sm text-gray-400">SOL Growth</div>
                    <div className={`text-lg font-semibold ${getGrowthColor(token.solPerToken.growth)}`}>
                      {formatPercentage(token.solPerToken.growth)}
                    </div>
                  </div>
                  
                  <div className="text-center lg:text-left">
                    <div className="text-sm text-gray-400">Last Updated</div>
                    <div className="text-lg font-semibold text-white">
                      {formatDistanceToNow(new Date(token.last_updated_at), { addSuffix: true })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Inline Chart */}
              {expandedChart === token.token_address && (
                <div className="mt-4 pt-4 border-t border-gray-700">
                  <div className="relative" style={{ height: '400px' }}>
                    {isChartLoading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-gray-800 rounded-lg">
                        <div className="flex items-center space-x-2">
                          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                          <span className="text-gray-400">Loading chart...</span>
                        </div>
                      </div>
                    )}
                    <iframe
                      src={`https://www.gmgn.cc/kline/sol/${token.token_address}?interval=1D&theme=dark`}
                      className="w-full h-full rounded-lg"
                      style={{ 
                        border: 'none', 
                        display: isChartLoading ? 'none' : 'block' 
                      }}
                      title={`GMGN Chart - ${token.token_symbol}`}
                      onLoad={() => setIsChartLoading(false)}
                      onError={() => {
                        console.error('Chart failed to load for token:', token.token_address)
                        setIsChartLoading(false)
                      }}
                      allowFullScreen
                      frameBorder="0"
                      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                    />
                  </div>
                </div>
              )}

              {/* Additional Information */}
              <div className="mt-4 pt-4 border-t border-gray-700">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-gray-400">First Seen:</span>
                    <span className="ml-2 text-white">
                      {formatDistanceToNow(new Date(token.first_seen_at), { addSuffix: true })}
                    </span>
                  </div>
                  
                  {token.when_reach_80mc && (
                    <div>
                      <span className="text-gray-400">Reached 80M:</span>
                      <span className="ml-2 text-green-400">
                        {formatDistanceToNow(new Date(token.when_reach_80mc), { addSuffix: true })}
                      </span>
                    </div>
                  )}
                  
                  {token.when_reach_120mc && (
                    <div>
                      <span className="text-gray-400">Reached 120M:</span>
                      <span className="ml-2 text-green-400">
                        {formatDistanceToNow(new Date(token.when_reach_120mc), { addSuffix: true })}
                      </span>
                    </div>
                  )}
                  
                  {token.when_reach_200mc && (
                    <div>
                      <span className="text-gray-400">Reached 200M:</span>
                      <span className="ml-2 text-green-400">
                        {formatDistanceToNow(new Date(token.when_reach_200mc), { addSuffix: true })}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          
          {tokens.length === 0 && !loading && (
            <div className="text-center py-12">
              <div className="text-gray-400 text-lg">No tokens found matching your criteria</div>
              <p className="text-gray-500 mt-2">Try adjusting your filters or search terms</p>
            </div>
          )}
        </div>

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
            <div className="text-sm text-gray-400">
              Showing {((pagination.page - 1) * pagination.limit) + 1} to {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total} tokens
            </div>
            
            <div className="flex items-center space-x-2">
              <button
                onClick={() => fetchTokens(pagination.page - 1)}
                disabled={pagination.page <= 1 || loading}
                className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded text-sm transition-colors"
              >
                Previous
              </button>
              
              <span className="px-3 py-1 bg-blue-600 rounded text-sm">
                {pagination.page} of {pagination.totalPages}
              </span>
              
              <button
                onClick={() => fetchTokens(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages || loading}
                className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded text-sm transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}