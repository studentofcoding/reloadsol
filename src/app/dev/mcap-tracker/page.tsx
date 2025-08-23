'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { getTokenWithAnalytics, EnrichedTokenData } from '@/utils/data-aggregation'

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
    pnlTimeWindows: Record<string, {
      count: number
      timeDistribution: Record<string, number>
      peakHours: string[]
      avgTimeToReach: number
    }>
    mcapRangeAnalysis: {
      under50k: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
      from51to100k: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
      from101to200k: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
      from201to500k: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
      from501kto1M: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
      over1M: { count: number; avgMultiplier: number; maxDrawdown: number; avgGrowth: number }
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
  const [isPnlTimeWindowsExpanded, setIsPnlTimeWindowsExpanded] = useState(true)
  const [activeMcapFilter, setActiveMcapFilter] = useState<string | null>(null)

  const [analyticsData, setAnalyticsData] = useState<Record<string, EnrichedTokenData>>({})
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [expandedAnalytics, setExpandedAnalytics] = useState<Record<string, boolean>>({})
  
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
      
      // MCap range filtering takes precedence over manual MCap filters
      if (activeMcapFilter) {
        const mcapRanges = {
          'under50k': { min: 0, max: 49999 },
          'from51to100k': { min: 50000, max: 100000 },
          'from101to200k': { min: 100001, max: 200000 },
          'from201to500k': { min: 200001, max: 500000 },
          'from501kto1M': { min: 500001, max: 1000000 },
          'over1M': { min: 1000001, max: Number.MAX_SAFE_INTEGER }
        }
        
        const range = mcapRanges[activeMcapFilter as keyof typeof mcapRanges]
        if (range) {
          params.append('minMcap', range.min.toString())
          if (range.max !== Number.MAX_SAFE_INTEGER) {
            params.append('maxMcap', range.max.toString())
          }
        }
      } else {
        // Only use manual MCap filters if no range filter is active
        if (filters.minMcap) params.append('minMcap', filters.minMcap)
        if (filters.maxMcap) params.append('maxMcap', filters.maxMcap)
      }
      
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
  }, [filters, pagination.limit, activeMcapFilter])

  useEffect(() => {
    fetchTokens(1)
  }, [filters, activeMcapFilter])

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTokens(pagination.page)
    }, 30000) // Refresh every 30 seconds
    
    return () => clearInterval(interval)
  }, [fetchTokens, pagination.page])

  // Move analytics hooks BEFORE any early returns
  const fetchAnalyticsForTokens = useCallback(async (tokenAddresses: string[]) => {
  if (tokenAddresses.length === 0) return;
  
  // tokenAddresses is already the correct format
  
  try {
    const response = await fetch('/api/analytics/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tokenAddresses,
        maxAge: 60 // Only recent data
      })
    });
    
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status}`);
    }
    
    const result = await response.json();
    
    if (!result.success) {
      throw new Error(result.error || 'Analytics request failed');
    }
    
    // Update analytics data state
    const newAnalyticsData: Record<string, EnrichedTokenData> = {};
    result.data.forEach((token: EnrichedTokenData) => {
      newAnalyticsData[token.token_address] = token;
    });
    
    setAnalyticsData(prev => ({ ...prev, ...newAnalyticsData }));
    
  } catch (error) {
    console.error('Failed to fetch analytics for tokens:', error);
    // Don't throw here to prevent breaking the UI
  }
}, []);

  const toggleAnalytics = (tokenAddress: string) => {
    setExpandedAnalytics(prev => ({
      ...prev,
      [tokenAddress]: !prev[tokenAddress]
    }))
  }

  const getAnomalyColor = (anomalyType?: string) => {
    if (!anomalyType) return 'text-gray-400'
    if (anomalyType === 'high') return 'text-red-400'
    if (anomalyType === 'low') return 'text-blue-400'
    return 'text-yellow-400'
  }

  const getMomentumColor = (momentum?: number) => {
    if (momentum === undefined || momentum === null) return 'text-gray-400'
    if (momentum > 0.1) return 'text-green-400'
    if (momentum < -0.1) return 'text-red-400'
    return 'text-yellow-400'
  }

  const getMomentumCategoryColor = (category?: string) => {
    if (!category) return 'text-gray-400'
    if (category === 'explosive') return 'text-green-500'
    if (category === 'strong') return 'text-green-400'
    if (category === 'moderate') return 'text-yellow-400'
    if (category === 'weak') return 'text-orange-400'
    if (category === 'negative') return 'text-red-400'
    return 'text-gray-400'
  }

  const getMomentumSignalColor = (signalType?: string) => {
    if (!signalType) return 'text-gray-400'
    if (signalType === 'bullish_breakout') return 'text-green-400'
    if (signalType === 'bearish_breakout') return 'text-red-400'
    if (signalType === 'neutral') return 'text-yellow-400'
    return 'text-gray-400'
  }

  const getRiskColor = (riskScore?: number) => {
    if (riskScore === undefined || riskScore === null) return 'text-gray-400'
    if (riskScore > 0.7) return 'text-red-400'
    if (riskScore > 0.4) return 'text-yellow-400'
    return 'text-green-400'
  }

  const handleMcapRangeFilter = (rangeKey: string) => {
    if (activeMcapFilter === rangeKey) {
      // If clicking the same filter, clear it
      setActiveMcapFilter(null)
    } else {
      // Set new filter and clear any conflicting manual MCap filters
      setActiveMcapFilter(rangeKey)
      setFilters(prev => ({
        ...prev,
        minMcap: '',
        maxMcap: ''
      }))
    }
    // Reset to first page when filtering
    setPagination(prev => ({ ...prev, page: 1 }))
  }

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTokens(pagination.page)
    }, 30000)
    
    return () => clearInterval(interval)
  }, [fetchTokens, pagination.page])

  // Analytics useEffect - also moved before early return
  useEffect(() => {
    if (tokens.length > 0) {
      const tokenAddresses = tokens.map(t => t.token_address)
      fetchAnalyticsForTokens(tokenAddresses)
    }
  }, [tokens, fetchAnalyticsForTokens])

  // Utility functions
  const formatNumber = (num?: number | null): string => {
    // Guard against undefined, null, or non-finite values
    if (num === null || num === undefined) return '$0'
    const n = Number(num)
    if (!Number.isFinite(n)) return '$0'

    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
    return `$${n.toFixed(0)}`
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
                first_mcap: data.firstMcap,
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

            {/* PnL Time Windows Analysis */}
            {stats && stats.pnlTimeWindows && (
              <div className="bg-gray-800 rounded-lg p-6 mb-8">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-bold">PnL Time Windows Analysis</h3>
                  <button
                    onClick={() => setIsPnlTimeWindowsExpanded(!isPnlTimeWindowsExpanded)}
                    className="flex items-center space-x-2 px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded-md transition-colors duration-200"
                  >
                    <span className="text-sm text-gray-300">
                      {isPnlTimeWindowsExpanded ? 'Collapse' : 'Expand'}
                    </span>
                    <svg
                      className={`w-4 h-4 text-gray-300 transition-transform duration-200 ${
                        isPnlTimeWindowsExpanded ? 'rotate-180' : ''
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
                
                {isPnlTimeWindowsExpanded && (
                  <div className="transition-all duration-300 ease-in-out">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {Object.entries(stats.pnlTimeWindows)
                    .sort(([a], [b]) => {
                      const aNum = parseFloat(a.replace('%', ''))
                      const bNum = parseFloat(b.replace('%', ''))
                      return aNum - bNum
                    })
                    .map(([threshold, data]) => {
                      const thresholdNum = parseFloat(threshold.replace('%', ''))
                      const getThresholdColor = (num: number) => {
                        if (num >= 1000) return 'text-purple-400'
                        if (num >= 500) return 'text-pink-400'
                        if (num >= 200) return 'text-yellow-400'
                        if (num >= 100) return 'text-green-400'
                        return 'text-blue-400'
                      }
                      
                      const formatTimeToReach = (hours: number) => {
                        if (hours < 1) return `${Math.round(hours * 60)}m`
                        if (hours < 24) return `${hours.toFixed(1)}h`
                        const days = Math.floor(hours / 24)
                        const remainingHours = Math.round(hours % 24)
                        return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
                      }

                      return (
                        <div key={threshold} className="bg-gray-700 rounded-lg p-4">
                          <h4 className={`text-lg font-semibold mb-3 ${getThresholdColor(thresholdNum)}`}>
                            {threshold} Threshold
                          </h4>
                          
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <span className="text-gray-400">Tokens Reached:</span>
                              <span className="text-white font-medium">{data.count}</span>
                            </div>
                            
                            {data.avgTimeToReach > 0 && (
                              <div className="flex justify-between">
                                <span className="text-gray-400">Avg Time:</span>
                                <span className="text-white">{formatTimeToReach(data.avgTimeToReach)}</span>
                              </div>
                            )}
                            
                            {data.peakHours && data.peakHours.length > 0 && (
                              <div className="flex justify-between">
                                <span className="text-gray-400">Peak Hours:</span>
                                <span className="text-white text-xs">
                                  {data.peakHours.slice(0, 3).join(', ')}
                                  {data.peakHours.length > 3 && '...'}
                                </span>
                              </div>
                            )}
                            
                            {/* Time Distribution Visualization */}
                            {Object.keys(data.timeDistribution).length > 0 && (
                              <div className="mt-3">
                                <span className="text-gray-400 text-xs mb-2 block">Hourly Distribution:</span>
                                <div className="grid grid-cols-6 gap-1">
                                  {Array.from({ length: 24 }, (_, hour) => {
                                    const count = data.timeDistribution[hour.toString()] || 0
                                    const maxCount = Math.max(...Object.values(data.timeDistribution))
                                    const intensity = maxCount > 0 ? count / maxCount : 0
                                    const opacity = Math.max(0.1, intensity)
                                    
                                    return (
                                      <div
                                        key={hour}
                                        className={`h-2 rounded-sm ${getThresholdColor(thresholdNum).replace('text-', 'bg-').replace('-400', '-500')}`}
                                        style={{ opacity }}
                                        title={`${hour}:00 - ${count} tokens`}
                                      />
                                    )
                                  })}
                                </div>
                                <div className="flex justify-between text-xs text-gray-500 mt-1">
                                  <span>0h</span>
                                  <span>12h</span>
                                  <span>24h</span>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                </div>
                
                {/* Summary Statistics */}
                <div className="mt-6 pt-6 border-t border-gray-700">
                  <h4 className="text-lg font-semibold mb-4 text-center">Overall Summary</h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-400">
                        {Object.values(stats.pnlTimeWindows).reduce((sum, data) => sum + data.count, 0)}
                      </div>
                      <div className="text-gray-400">Total Threshold Breaches</div>
                    </div>
                    
                    <div className="text-center">
                      <div className="text-2xl font-bold text-green-400">
                        {Object.entries(stats.pnlTimeWindows)
                          .filter(([_, data]) => data.count > 0)
                          .length}
                      </div>
                      <div className="text-gray-400">Active Thresholds</div>
                    </div>
                    
                    <div className="text-center">
                      <div className="text-2xl font-bold text-purple-400">
                        {(() => {
                          const avgTimes = Object.values(stats.pnlTimeWindows)
                            .filter(data => data.avgTimeToReach > 0)
                            .map(data => data.avgTimeToReach)
                          
                          if (avgTimes.length === 0) return 'N/A'
                          
                          const overallAvg = avgTimes.reduce((sum, time) => sum + time, 0) / avgTimes.length
                          return overallAvg < 24 ? `${overallAvg.toFixed(1)}h` : `${(overallAvg / 24).toFixed(1)}d`
                        })()} 
                      </div>
                      <div className="text-gray-400">Avg Time to Threshold</div>
                    </div>
                  </div>
                </div>
                  </div>
                )}
              </div>
            )}

            {/* MCap Range Analysis */}
            <div className="bg-gray-800 rounded-lg p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-bold">MCap Range Analysis</h3>
                {activeMcapFilter && (
                  <button
                    onClick={() => setActiveMcapFilter(null)}
                    className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded-md text-sm transition-colors"
                  >
                    Clear Filter
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <button
                  onClick={() => handleMcapRangeFilter('under50k')}
                  className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                    activeMcapFilter === 'under50k' ? 'ring-2 ring-blue-400 bg-gray-600' : ''
                  }`}
                >
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
                </button>
                
                <button
                  onClick={() => handleMcapRangeFilter('from51to100k')}
                  className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                    activeMcapFilter === 'from51to100k' ? 'ring-2 ring-green-400 bg-gray-600' : ''
                  }`}
                >
                  <h4 className="text-lg font-semibold text-green-400 mb-2">50K-100K MCap</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Count:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.from51to100k.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Multiplier:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.from51to100k.avgMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Max Drawdown:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.from51to100k.maxDrawdown)}>
                        {formatPercentage(stats.mcapRangeAnalysis.from51to100k.maxDrawdown)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Growth:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.from51to100k.avgGrowth)}>
                        {formatPercentage(stats.mcapRangeAnalysis.from51to100k.avgGrowth)}
                      </span>
                    </div>
                  </div>
                </button>
                
                <button
                  onClick={() => handleMcapRangeFilter('from101to200k')}
                  className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                    activeMcapFilter === 'from101to200k' ? 'ring-2 ring-purple-400 bg-gray-600' : ''
                  }`}
                >
                  <h4 className="text-lg font-semibold text-purple-400 mb-2">101K-200K MCap</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Count:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.from101to200k.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Multiplier:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.from101to200k.avgMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Max Drawdown:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.from101to200k.maxDrawdown)}>
                        {formatPercentage(stats.mcapRangeAnalysis.from101to200k.maxDrawdown)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Growth:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.from101to200k.avgGrowth)}>
                        {formatPercentage(stats.mcapRangeAnalysis.from101to200k.avgGrowth)}
                      </span>
                    </div>
                  </div>
                </button>
                
                <button
                  onClick={() => handleMcapRangeFilter('from201to500k')}
                  className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                    activeMcapFilter === 'from201to500k' ? 'ring-2 ring-yellow-400 bg-gray-600' : ''
                  }`}
                >
                  <h4 className="text-lg font-semibold text-yellow-400 mb-2">201K-500K MCap</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Count:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.from201to500k.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Multiplier:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.from201to500k.avgMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Max Drawdown:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.from201to500k.maxDrawdown)}>
                        {formatPercentage(stats.mcapRangeAnalysis.from201to500k.maxDrawdown)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Growth:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.from201to500k.avgGrowth)}>
                        {formatPercentage(stats.mcapRangeAnalysis.from201to500k.avgGrowth)}
                      </span>
                    </div>
                  </div>
                </button>
                
                <button
                  onClick={() => handleMcapRangeFilter('from501kto1M')}
                  className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                    activeMcapFilter === 'from501kto1M' ? 'ring-2 ring-orange-400 bg-gray-600' : ''
                  }`}
                >
                  <h4 className="text-lg font-semibold text-orange-400 mb-2">501K-1M MCap</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Count:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.from501kto1M.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Multiplier:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.from501kto1M.avgMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Max Drawdown:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.from501kto1M.maxDrawdown)}>
                        {formatPercentage(stats.mcapRangeAnalysis.from501kto1M.maxDrawdown)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Growth:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.from501kto1M.avgGrowth)}>
                        {formatPercentage(stats.mcapRangeAnalysis.from501kto1M.avgGrowth)}
                      </span>
                    </div>
                  </div>
                </button>
                
                <button
                  onClick={() => handleMcapRangeFilter('over1M')}
                  className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                    activeMcapFilter === 'over1M' ? 'ring-2 ring-pink-400 bg-gray-600' : ''
                  }`}
                >
                  <h4 className="text-lg font-semibold text-pink-400 mb-2">&gt;1M MCap</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Count:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.over1M.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Multiplier:</span>
                      <span className="text-white">{stats.mcapRangeAnalysis.over1M.avgMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Max Drawdown:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.over1M.maxDrawdown)}>
                        {formatPercentage(stats.mcapRangeAnalysis.over1M.maxDrawdown)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Avg Growth:</span>
                      <span className={getGrowthColor(stats.mcapRangeAnalysis.over1M.avgGrowth)}>
                        {formatPercentage(stats.mcapRangeAnalysis.over1M.avgGrowth)}
                      </span>
                    </div>
                  </div>
                </button>
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

                  <div className="flex justify-end">
                    <span className="text-gray-400">Last Updated:</span>
                    <span className="ml-2 text-white">
                      {formatDistanceToNow(new Date(token.last_updated_at), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              </div>
            
            {/* Analytics Section - Add this after the existing token information */}
                <div className="mt-4 pt-4 border-t border-gray-700">
                  <button
                    onClick={() => toggleAnalytics(token.token_address)}
                    className="flex items-center justify-between w-full text-left hover:text-blue-400 transition-colors"
                  >
                    <div className="flex items-center space-x-2">
                      <span className="text-sm font-medium text-gray-300">Analytics & Risk Assessment</span>
                      {analyticsLoading && (
                        <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                      )}
                    </div>
                    <svg
                      className={`w-4 h-4 transition-transform ${expandedAnalytics[token.token_address] ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {expandedAnalytics[token.token_address] && (
                    <div className="mt-4 space-y-4 bg-gray-750 rounded-lg p-4">
                      {analyticsData[token.token_address] ? (
                        <>
                          {/* Z-Score Anomaly Detection */}
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                                <div className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">Z-Score</div>
                                <div className={`text-lg font-semibold ${
                                    analyticsData[token.token_address]?.z_score !== undefined ? 
                                    Math.abs(analyticsData[token.token_address].z_score!) > 2 ? 'text-red-400' :
                                    Math.abs(analyticsData[token.token_address].z_score!) > 1 ? 'text-yellow-400' : 'text-green-400'
                                    : 'text-gray-400'
                                }`}>
                                    {analyticsData[token.token_address]?.z_score?.toFixed(2) ?? 'N/A'}
                                </div>
                                </div>

                                <div className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">Anomaly Type</div>
                                <div className={`text-sm font-medium capitalize ${getAnomalyColor(analyticsData[token.token_address]?.anomaly_type)}`}>
                                    {analyticsData[token.token_address]?.anomaly_type || 'neutral'}
                                </div>
                                </div>

                                <div className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">Momentum</div>
                                <div className={`text-sm font-medium capitalize ${getMomentumCategoryColor(analyticsData[token.token_address]?.momentum_category)}`}>
                                {analyticsData[token.token_address]?.momentum_category || 'N/A'}
                              </div>
                                </div>

                                <div className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">Risk Score</div>
                                <div className={`text-lg font-semibold ${getRiskColor(analyticsData[token.token_address]?.risk_score)}`}>
                                    {analyticsData[token.token_address]?.risk_score ? `${(analyticsData[token.token_address].risk_score! * 100).toFixed(0)}%` : 'N/A'}
                                </div>
                                </div>
                            </div>

                          {/* Momentum Signal Details */}
                            {analyticsData[token.token_address]?.momentum_signal && (
                              <div className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">Signal</div>
                                <div className="text-sm">
                                  <span className={`capitalize ${getMomentumSignalColor(analyticsData[token.token_address]?.momentum_signal?.type)}`}>
                                    {analyticsData[token.token_address]?.momentum_signal?.type?.replace('_', ' ')}
                                  </span>
                                  <div className="text-xs text-gray-400 mt-1">
                                    Strength: {(analyticsData[token.token_address]?.momentum_signal?.strength ?? 0 * 100).toFixed(0)}%
                                  </div>
                                </div>
                              </div>
                            )}

                          {/* Additional Metrics */}
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {analyticsData[token.token_address]?.current_price_usd && (
                            <div className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">Current Price</div>
                                <div className="text-sm text-white">
                                ${analyticsData[token.token_address].current_price_usd!.toFixed(6)}
                                </div>
                            </div>
                            )}

                            {analyticsData[token.token_address]?.liquidity_score !== undefined && (
                              <div className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">Liquidity Score</div>
                                <div className="text-sm text-white">
                                  {(analyticsData[token.token_address]!.liquidity_score! * 100).toFixed(0)}%
                                </div>
                              </div>
                            )}

                            {analyticsData[token.token_address]?.volume_24h !== undefined && (
                              <div className="bg-gray-800 rounded-lg p-3">
                                <div className="text-xs text-gray-400 mb-1">24h Volume</div>
                                <div className="text-sm text-white">
                                  ${analyticsData[token.token_address]!.volume_24h!.toLocaleString()}
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="text-xs text-gray-500 mt-2">
                            Analytics updated: {formatDistanceToNow(new Date(analyticsData[token.token_address].last_updated_at), { addSuffix: true })}
                          </div>
                        </>
                      ) : (
                        <div className="text-center py-4">
                          <div className="text-gray-400">Analytics data not available</div>
                          <button
                            onClick={() => fetchAnalyticsForTokens([token.token_address])}
                            className="mt-2 px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm transition-colors"
                          >
                            Retry Analytics
                          </button>
                        </div>
                      )}
                    </div>
                  )}
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