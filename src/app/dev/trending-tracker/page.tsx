'use client'

import React, { useState, useEffect } from 'react'

interface TopWinner {
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  peak_price_usd: number
  peak_gain_percentage: number
  tracking_duration_hours: number
  status_changed_at: string
}

interface TrackedToken {
  id: string
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  last_price_usd: number
  peak_price_usd: number
  current_gain_percentage: number
  peak_gain_percentage: number
  status: 'tracking' | 'won' | 'lost'
  organic_score: number | null
  market_cap: number | null
  volume_1h: number | null
  tracking_started_at: string
  status_changed_at: string | null
  created_at: string
  updated_at: string
}

interface Summary {
  id: string
  period_start: string
  period_end: string
  total_tokens_tracked: number
  won_tokens: number
  lost_tokens: number
  still_tracking: number
  win_rate: number
  top_winners: TopWinner[]
  avg_peak_gain: number
  max_peak_gain: number
  avg_loss: number
  created_at: string
}

interface TrendingStats {
  success: boolean
  timestamp: string
  latest_summary: Summary | null
  current_tracking: {
    tokens: TrackedToken[]
    statistics: {
      total_tracking: number
      positive_performers: number
      negative_performers: number
      at_risk: number
      top_performer: {
        token_symbol: string
        token_name: string
        current_gain_percentage: number
        peak_gain_percentage: number
      } | null
    }
    averages: {
      current_gain: number
      peak_gain: number
    }
  }
  recent_completed: {
    winners: TrackedToken[]
    losers: TrackedToken[]
  }
  trends: {
    win_rate_change: number
    historical_summaries: Summary[]
  }
  data_freshness: {
    tracking_tokens_count: number
    latest_summary_age_hours: number | null
    last_updated: string
  }
}

export default function TrendingTrackerPage() {
  const [stats, setStats] = useState<TrendingStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')
  const [activeTab, setActiveTab] = useState<'overview' | 'tracking' | 'winners' | 'losers'>('overview')
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [debugMode, setDebugMode] = useState(false)
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false)

  // Update prices for currently tracked tokens
  const updateTokenPrices = async (tokens: TrackedToken[]): Promise<boolean> => {
    if (tokens.length === 0) return false
    
    try {
      console.log('💰 Updating prices for tracked tokens...')
      setIsRefreshingPrices(true)
      
      // Extract token addresses
      const tokenAddresses = tokens.map(token => token.token_address)
      
      // Fetch fresh prices from our price API
      const priceResponse = await fetch('/api/tokens/prices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tokens: tokenAddresses })
      })
      
      if (!priceResponse.ok) {
        console.warn('⚠️ Price API failed, skipping price updates')
        return false
      }
      
      const priceData = await priceResponse.json()
      console.log('💰 Fresh prices received:', {
        total_tokens: tokenAddresses.length,
        cached_tokens: priceData.cached_tokens,
        fresh_tokens: priceData.fresh_tokens,
        rate_limit_remaining: priceData.rate_limit_remaining
      })
      
      // Update each token's price if we got fresh data
      if (priceData.prices && Object.keys(priceData.prices).length > 0) {
        const updatePromises = tokens.map(async (token) => {
          const newPrice = priceData.prices[token.token_address]
          if (newPrice && newPrice > 0 && newPrice !== token.last_price_usd) {
            // Calculate new gain percentages
            const currentGain = ((newPrice - token.initial_price_usd) / token.initial_price_usd) * 100
            const newPeakPrice = Math.max(token.peak_price_usd, newPrice)
            const peakGain = ((newPeakPrice - token.initial_price_usd) / token.initial_price_usd) * 100
            
            console.log(`📈 Updating ${token.token_symbol}: $${token.last_price_usd.toFixed(6)} → $${newPrice.toFixed(6)} (${currentGain.toFixed(2)}%)`)
            
            // Update token in database (import supabase client)
            const { supabase } = await import('@/utils/supabase')
            const { error } = await supabase
              .from('trending_token_tracker')
              .update({
                last_price_usd: newPrice,
                peak_price_usd: newPeakPrice,
                current_gain_percentage: currentGain,
                peak_gain_percentage: peakGain,
                updated_at: new Date().toISOString()
              })
              .eq('id', token.id)
            
            if (error) {
              console.error(`❌ Failed to update ${token.token_symbol}:`, error)
            }
          }
        })
        
        await Promise.allSettled(updatePromises)
        console.log('✅ Price updates completed')
        return true
      }
      
      return false
    } catch (error) {
      console.error('❌ Error updating token prices:', error)
      return false
    } finally {
      setIsRefreshingPrices(false)
    }
  }

  // Fetch stats from API
  const fetchStats = async (updatePrices: boolean = false) => {
    try {
      setError('')
      console.log('🔄 Fetching trending stats from /api/trending/stats...')
      
      const response = await fetch('/api/trending/stats')
      console.log('📡 API Response status:', response.status)
      console.log('📡 API Response headers:', Object.fromEntries(response.headers))
      
      if (!response.ok) {
        const errorText = await response.text()
        console.error('❌ API Error Response:', errorText)
        throw new Error(`API responded with status: ${response.status} - ${errorText}`)
      }
      
      const data = await response.json()
      console.log('✅ Trending stats received:', {
        success: data.success,
        timestamp: data.timestamp,
        latest_summary: data.latest_summary ? {
          id: data.latest_summary.id,
          win_rate: data.latest_summary.win_rate,
          total_tokens_tracked: data.latest_summary.total_tokens_tracked,
          created_at: data.latest_summary.created_at
        } : null,
        current_tracking: {
          tokens_count: data.current_tracking?.tokens?.length || 0,
          statistics: data.current_tracking?.statistics
        },
        recent_completed: {
          winners_count: data.recent_completed?.winners?.length || 0,
          losers_count: data.recent_completed?.losers?.length || 0
        },
        data_freshness: data.data_freshness
      })
      
      // Log detailed tracking tokens info
      if (data.current_tracking?.tokens?.length > 0) {
        console.log('🎯 Currently tracking tokens:', data.current_tracking.tokens.map((token: TrackedToken) => ({
          symbol: token.token_symbol,
          address: token.token_address.slice(0, 8) + '...',
          current_gain: token.current_gain_percentage,
          peak_gain: token.peak_gain_percentage,
          status: token.status,
          tracking_started: token.tracking_started_at
        })))
      } else {
        console.warn('⚠️ No tokens currently being tracked')
      }
      
      // Log recent winners/losers
      if (data.recent_completed?.winners?.length > 0) {
        console.log('🏆 Recent winners:', data.recent_completed.winners.map((w: TrackedToken) => ({
          symbol: w.token_symbol,
          peak_gain: w.peak_gain_percentage,
          status_changed: w.status_changed_at
        })))
      }
      
      if (data.recent_completed?.losers?.length > 0) {
        console.log('💔 Recent losers:', data.recent_completed.losers.map((l: TrackedToken) => ({
          symbol: l.token_symbol,
          current_gain: l.current_gain_percentage,
          status_changed: l.status_changed_at
        })))
      }
      
      setStats(data)
      
      // If updatePrices is true and we have tracking tokens, update their prices
      if (updatePrices && data.current_tracking?.tokens?.length > 0) {
        console.log('🔄 Refresh Stats with price updates requested...')
        const pricesUpdated = await updateTokenPrices(data.current_tracking.tokens)
        
        if (pricesUpdated) {
          // Fetch stats again to get the updated data
          console.log('🔄 Refetching stats after price updates...')
          const updatedResponse = await fetch('/api/trending/stats')
          if (updatedResponse.ok) {
            const updatedData = await updatedResponse.json()
            setStats(updatedData)
            console.log('✅ Stats refreshed with updated prices')
          }
        }
      }
      
      setLastRefresh(new Date())
    } catch (err) {
      console.error('❌ Error fetching trending stats:', err)
      console.error('❌ Error details:', {
        message: err instanceof Error ? err.message : 'Unknown error',
        stack: err instanceof Error ? err.stack : undefined,
        timestamp: new Date().toISOString()
      })
      setError(err instanceof Error ? err.message : 'Failed to fetch data')
    } finally {
      setLoading(false)
    }
  }

  // Enhanced refresh function for manual button clicks
  const handleRefreshStats = async () => {
    await fetchStats(true) // Update prices when manually refreshing
  }

  // Debug function to manually test tracking API (development mode only)
  const testTrackingAPI = async () => {
    console.log('🧪 Testing tracking API manually...')
    try {
      const response = await fetch('/api/trending/track', {
        method: 'POST'
      })
      console.log('🔍 Tracking API response status:', response.status)
      
      if (!response.ok) {
        const errorText = await response.text()
        console.error('❌ Tracking API Error:', errorText)
        return
      }
      
      const data = await response.json()
      console.log('✅ Tracking API response:', data)
    } catch (err) {
      console.error('❌ Error testing tracking API:', err)
    }
  }

  // Debug function to manually test summary API (development mode only)
  const testSummaryAPI = async () => {
    console.log('🧪 Testing summary API manually...')
    try {
      const response = await fetch('/api/trending/summary', {
        method: 'POST'
      })
      console.log('📊 Summary API response status:', response.status)
      
      if (!response.ok) {
        const errorText = await response.text()
        console.error('❌ Summary API Error:', errorText)
        return
      }
      
      const data = await response.json()
      console.log('✅ Summary API response:', data)
    } catch (err) {
      console.error('❌ Error testing summary API:', err)
    }
  }

  // Auto-refresh every 30 seconds (without price updates to avoid rate limiting)
  useEffect(() => {
    fetchStats(false) // Initial load without price updates
    
    const interval = setInterval(() => {
      fetchStats(false) // Auto-refresh without price updates
    }, 30000) // 30 seconds
    
    return () => clearInterval(interval)
  }, [])

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleString()
  }

  const formatRelativeTime = (dateString: string) => {
    const now = Date.now()
    const then = new Date(dateString).getTime()
    const diff = now - then
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor(diff / (1000 * 60))
    
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return 'Just now'
  }

  const formatPercentage = (percentage: number, showSign: boolean = true) => {
    const color = percentage > 0 ? 'text-green-400' : percentage < 0 ? 'text-red-400' : 'text-gray-400'
    const sign = showSign && percentage > 0 ? '+' : ''
    return (
      <span className={color}>
        {sign}{percentage.toFixed(2)}%
      </span>
    )
  }

  const formatPrice = (price: number) => {
    if (price >= 1) return `$${price.toFixed(4)}`
    if (price >= 0.001) return `$${price.toFixed(6)}`
    return `$${price.toExponential(2)}`
  }

  const TokenIcon = ({ token }: { token: TrackedToken | TopWinner }) => (
    <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center overflow-hidden">
      {token.logo_url ? (
        <img 
          src={token.logo_url} 
          alt={token.token_symbol || 'Token'} 
          className="w-full h-full object-cover" 
          onError={(e) => {
            e.currentTarget.onerror = null
            e.currentTarget.src = ''
            if (e.currentTarget.parentElement) {
              e.currentTarget.parentElement.textContent = (token.token_symbol || '?').charAt(0).toUpperCase()
            }
          }} 
        />
      ) : (
        <span className="text-white text-sm font-bold">
          {(token.token_symbol || '?').charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  )

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold mb-8">Trending Token Tracker</h1>
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-2 border-blue-400 border-t-blue-200 rounded-full animate-spin"></div>
            <span className="ml-3 text-gray-400">Loading tracking data...</span>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold mb-8">Trending Token Tracker</h1>
          <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-6 text-center">
            <p className="text-red-400 text-lg mb-4">Error loading data</p>
            <p className="text-red-300 text-sm mb-4">{error}</p>
            <button 
              onClick={() => fetchStats(false)}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold mb-8">Trending Token Tracker</h1>
          <p className="text-gray-400">No data available</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col space-y-4 md:flex-row md:items-center md:justify-between md:space-y-0 mb-8">
          <h1 className="text-2xl md:text-3xl font-bold">Trending Token Tracker</h1>
          <div className="text-left md:text-right space-y-2">
            <p className="text-sm text-gray-400">Last updated: {formatRelativeTime(lastRefresh.toISOString())}</p>
            <div className="flex flex-wrap gap-2">
              <button 
                onClick={handleRefreshStats}
                className={`text-blue-400 hover:text-blue-300 text-sm transition-colors ${isRefreshingPrices ? 'opacity-50' : ''}`}
                disabled={isRefreshingPrices}
              >
                {isRefreshingPrices ? 'Updating...' : 'Refresh'}
              </button>
              <button 
                onClick={testTrackingAPI}
                className="text-yellow-400 hover:text-yellow-300 text-sm transition-colors"
              >
                Test Track
              </button>
              <button 
                onClick={testSummaryAPI}
                className="text-green-400 hover:text-green-300 text-sm transition-colors"
              >
                Test Summary
              </button>
              <button 
                onClick={() => setDebugMode(!debugMode)}
                className="text-purple-400 hover:text-purple-300 text-sm transition-colors"
              >
                Debug: {debugMode ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </div>

        {/* Debug Info */}
        {debugMode && (
          <div className="bg-purple-900/20 border border-purple-600/30 rounded-xl p-4 mb-8">
            <h3 className="text-lg font-semibold mb-3 text-purple-400">🔧 Debug Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-gray-400">API Base URL:</p>
                <p className="text-white font-mono">{window.location.origin}</p>
              </div>
              <div>
                <p className="text-gray-400">Current Time:</p>
                <p className="text-white font-mono">{new Date().toISOString()}</p>
              </div>
              <div>
                <p className="text-gray-400">Last Refresh:</p>
                <p className="text-white font-mono">{lastRefresh.toISOString()}</p>
              </div>
              <div>
                <p className="text-gray-400">Stats Response:</p>
                <p className="text-white font-mono">{stats ? 'Loaded' : 'No data'}</p>
              </div>
            </div>
            <div className="mt-4 p-3 bg-gray-800 rounded-lg">
              <p className="text-xs text-gray-400 mb-2">Console Commands (open browser dev tools):</p>
              <div className="space-y-1 text-xs font-mono">
                <p className="text-green-400">• Check all console logs for detailed API responses</p>
                <p className="text-yellow-400">• Click "Test Tracking" to manually trigger 5-min update</p>
                <p className="text-blue-400">• Click "Test Summary" to manually trigger 24h summary</p>
                <p className="text-purple-400">• Watch for Jupiter API calls and Supabase operations</p>
              </div>
            </div>
          </div>
        )}

        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-6 mb-8">
          {/* Win Rate */}
          <div className="bg-gray-800 rounded-xl p-3 md:p-6">
            <h3 className="text-sm md:text-lg font-semibold mb-2">Win Rate</h3>
            <p className="text-xl md:text-3xl font-bold text-green-400">
              {stats.latest_summary?.win_rate?.toFixed(1) || '0.0'}%
            </p>
            {stats.trends.win_rate_change !== 0 && (
              <p className="text-xs md:text-sm mt-1">
                {formatPercentage(stats.trends.win_rate_change)} vs yesterday
              </p>
            )}
          </div>

          {/* Currently Tracking */}
          <div className="bg-gray-800 rounded-xl p-3 md:p-6">
            <h3 className="text-sm md:text-lg font-semibold mb-2">Tracking</h3>
            <p className="text-xl md:text-3xl font-bold text-blue-400">
              {stats.current_tracking.statistics.total_tracking}
            </p>
            <p className="text-xs md:text-sm text-gray-400 mt-1">
              {stats.current_tracking.statistics.positive_performers} gaining
              <span className="hidden md:inline"> • {stats.current_tracking.statistics.at_risk} at risk</span>
            </p>
          </div>

          {/* Best Performer */}
          <div className="bg-gray-800 rounded-xl p-3 md:p-6">
            <h3 className="text-sm md:text-lg font-semibold mb-2">Top Performer</h3>
            {stats.current_tracking.statistics.top_performer ? (
              <>
                <p className="text-sm md:text-lg font-bold text-white truncate">
                  {stats.current_tracking.statistics.top_performer.token_symbol}
                </p>
                <p className="text-xs md:text-sm">
                  {formatPercentage(stats.current_tracking.statistics.top_performer.peak_gain_percentage)}
                </p>
              </>
            ) : (
              <p className="text-xs md:text-sm text-gray-400">No active tokens</p>
            )}
          </div>

          {/* Latest Summary Age */}
          <div className="bg-gray-800 rounded-xl p-3 md:p-6">
            <h3 className="text-sm md:text-lg font-semibold mb-2">Last Summary</h3>
            <p className="text-sm md:text-lg font-bold text-white">
              {stats.data_freshness.latest_summary_age_hours !== null 
                ? `${stats.data_freshness.latest_summary_age_hours.toFixed(1)}h ago`
                : 'Never'
              }
            </p>
            {stats.latest_summary && (
              <p className="text-xs md:text-sm text-gray-400 mt-1">
                {stats.latest_summary.won_tokens} wins<span className="hidden md:inline"> • {stats.latest_summary.lost_tokens} losses</span>
              </p>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex space-x-1 mb-6 bg-gray-800 rounded-lg p-1 overflow-x-auto">
          {[
            { 
              key: 'overview', 
              label: 'Overview',
              icon: (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              )
            },
            { 
              key: 'tracking', 
              label: `Tracking (${stats.current_tracking.statistics.total_tracking})`,
              icon: (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )
            },
            { 
              key: 'winners', 
              label: `Winners (${stats.recent_completed.winners.length})`,
              icon: (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
                </svg>
              )
            },
            { 
              key: 'losers', 
              label: `Losers (${stats.recent_completed.losers.length})`,
              icon: (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17.294 15m-3.294-5a2 2 0 012-2h5.5a2 2 0 012 2v6a2 2 0 01-2 2h-5.5a2 2 0 01-2-2v-6z" />
                </svg>
              )
            }
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as any)}
              className={`flex items-center justify-center space-x-2 px-4 py-2 text-sm font-medium rounded-md transition-all min-w-max ${
                activeTab === tab.key
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
              }`}
              title={tab.label}
            >
              {tab.icon}
              <span className="hidden md:inline">{tab.label}</span>
              {/* Show count badge on mobile */}
              <span className="md:hidden">
                {tab.key === 'tracking' && stats.current_tracking.statistics.total_tracking > 0 && (
                  <span className="ml-1 bg-blue-600 text-xs px-1.5 py-0.5 rounded-full">
                    {stats.current_tracking.statistics.total_tracking}
                  </span>
                )}
                {tab.key === 'winners' && stats.recent_completed.winners.length > 0 && (
                  <span className="ml-1 bg-green-600 text-xs px-1.5 py-0.5 rounded-full">
                    {stats.recent_completed.winners.length}
                  </span>
                )}
                {tab.key === 'losers' && stats.recent_completed.losers.length > 0 && (
                  <span className="ml-1 bg-red-600 text-xs px-1.5 py-0.5 rounded-full">
                    {stats.recent_completed.losers.length}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Latest Summary */}
            {stats.latest_summary && (
              <div className="bg-gray-800 rounded-xl p-6">
                <h3 className="text-xl font-semibold mb-4">Latest 24h Summary</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  <div>
                    <p className="text-sm text-gray-400">Period</p>
                    <p className="text-white">{formatTime(stats.latest_summary.period_start)} - {formatTime(stats.latest_summary.period_end)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-400">Total Tracked</p>
                    <p className="text-white font-semibold">{stats.latest_summary.total_tokens_tracked}</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-400">Win Rate</p>
                    <p className="text-green-400 font-semibold">{stats.latest_summary.win_rate}%</p>
                  </div>
                </div>

                {/* Top Winners from Summary */}
                {stats.latest_summary.top_winners && stats.latest_summary.top_winners.length > 0 && (
                  <div>
                    <h4 className="text-lg font-semibold mb-3">🏆 Top 5 Winners</h4>
                    <div className="space-y-2">
                      {stats.latest_summary.top_winners.map((winner, index) => (
                        <div key={winner.token_address} className="flex items-center justify-between p-3 bg-gray-700 rounded-lg">
                          <div className="flex items-center space-x-3">
                            <span className="text-yellow-400 font-bold">#{index + 1}</span>
                            <TokenIcon token={winner} />
                            <div>
                              <p className="font-semibold">{winner.token_symbol || 'Unknown'}</p>
                              <p className="text-sm text-gray-400">{winner.token_name}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-green-400 font-semibold">+{winner.peak_gain_percentage.toFixed(2)}%</p>
                            <p className="text-sm text-gray-400">{winner.tracking_duration_hours.toFixed(1)}h tracked</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Current Averages */}
            <div className="bg-gray-800 rounded-xl p-6">
              <h3 className="text-xl font-semibold mb-4">Current Performance</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-sm text-gray-400 mb-1">Average Current Gain</p>
                  <p className="text-2xl font-bold">
                    {formatPercentage(stats.current_tracking.averages.current_gain)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-400 mb-1">Average Peak Gain</p>
                  <p className="text-2xl font-bold">
                    {formatPercentage(stats.current_tracking.averages.peak_gain)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'tracking' && (
          <div className="bg-gray-800 rounded-xl p-6">
            <h3 className="text-xl font-semibold mb-4">Currently Tracking ({stats.current_tracking.tokens.length})</h3>
            {stats.current_tracking.tokens.length === 0 ? (
              <p className="text-gray-400 text-center py-8">No tokens currently being tracked</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.current_tracking.tokens.slice(0, 20).map(token => (
                  <div key={token.id} className="p-4 bg-gray-800 rounded-xl border border-gray-700 hover:border-gray-500 transition-all duration-200">
                    <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-3">
                      <TokenIcon token={token} />
                      <div>
                          <div className="font-semibold text-white">{token.token_symbol || 'Unknown'}</div>
                          <div className="text-xs text-gray-400 truncate max-w-32">
                            {token.token_name}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-white font-medium">
                          {formatPrice(token.last_price_usd)}
                        </div>
                        <div className={`text-xs ${token.current_gain_percentage >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPercentage(token.current_gain_percentage, true)}
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between text-xs mt-2">
                      <div>
                        <span className="text-gray-400">Peak: </span>
                        <span className={token.peak_gain_percentage >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {formatPercentage(token.peak_gain_percentage, true)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">Since: </span>
                        <span className="text-white">{formatRelativeTime(token.tracking_started_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'winners' && (
          <div className="bg-gray-800 rounded-xl p-6">
            <h3 className="text-xl font-semibold mb-4">Recent Winners ({stats.recent_completed.winners.length})</h3>
            {stats.recent_completed.winners.length === 0 ? (
              <p className="text-gray-400 text-center py-8">No recent winners</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.recent_completed.winners.map(token => (
                  <div key={token.id} className="p-4 bg-gray-800 rounded-xl border border-green-600/30 hover:border-green-500/50 transition-all duration-200">
                    <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-3">
                        <div className="relative">
                      <TokenIcon token={token} />
                          <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-600 rounded-full flex items-center justify-center">
                            <svg className="w-2 h-2 text-white" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          </div>
                        </div>
                      <div>
                          <div className="font-semibold text-white">{token.token_symbol || 'Unknown'}</div>
                          <div className="text-xs text-gray-400 truncate max-w-32">
                            {token.token_name}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-white font-medium">
                          {formatPrice(token.last_price_usd)}
                        </div>
                        <div className="text-xs text-green-400">
                          +{token.peak_gain_percentage.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between text-xs mt-2">
                      <div>
                        <span className="text-gray-400">Final: </span>
                        <span className="text-green-400">
                          +{token.current_gain_percentage.toFixed(2)}%
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">Won: </span>
                        <span className="text-white">{formatRelativeTime(token.status_changed_at || token.updated_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'losers' && (
          <div className="bg-gray-800 rounded-xl p-6">
            <h3 className="text-xl font-semibold mb-4">Recent Losers ({stats.recent_completed.losers.length})</h3>
            {stats.recent_completed.losers.length === 0 ? (
              <p className="text-gray-400 text-center py-8">No recent losers</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.recent_completed.losers.map(token => (
                  <div key={token.id} className="p-4 bg-gray-800 rounded-xl border border-red-600/30 hover:border-red-500/50 transition-all duration-200">
                    <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-3">
                        <div className="relative">
                      <TokenIcon token={token} />
                          <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-600 rounded-full flex items-center justify-center">
                            <svg className="w-2 h-2 text-white" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                          </div>
                        </div>
                      <div>
                          <div className="font-semibold text-white">{token.token_symbol || 'Unknown'}</div>
                          <div className="text-xs text-gray-400 truncate max-w-32">
                            {token.token_name}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-white font-medium">
                          {formatPrice(token.last_price_usd)}
                        </div>
                        <div className="text-xs text-red-400">
                          {token.current_gain_percentage.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between text-xs mt-2">
                      <div>
                        <span className="text-gray-400">Peak: </span>
                        <span className={token.peak_gain_percentage >= 0 ? 'text-green-400' : 'text-red-400'}>
                          {formatPercentage(token.peak_gain_percentage, true)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">Lost: </span>
                        <span className="text-white">{formatRelativeTime(token.status_changed_at || token.updated_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
} 