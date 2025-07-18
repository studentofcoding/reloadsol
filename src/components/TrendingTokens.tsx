'use client'

import React, { useEffect, useState, useRef } from 'react'
import ChartOverview from './ChartOverview'
import TokenSkeleton from './TokenSkeleton'
import { fetchAxiomTokenInfo, getRiskIndicators, formatRiskDisplay } from '@/utils/axiom'

interface TrendingToken {
  token_symbol: string
  token_address: string
  price: number
  change_1h: number
  change_5m: number
  volume_1h: number
  logo_url?: string
  created_at?: number
}

interface AxiomTokenInfo {
  numHolders: number
  numBotUsers: number
  top10HoldersPercent: number
  devHoldsPercent: number
  insidersHoldPercent: number
  bundlersHoldPercent: number
  snipersHoldPercent: number
  dexPaid: boolean
  totalPairFeesPaid: number
}

interface RiskIndicators {
  insiderRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  bundlerRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  sniperRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  concentrationRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  overallRisk: 'LOW' | 'MEDIUM' | 'HIGH'
}

interface TokenPrice {
  token_address: string
  price: number
  change_5m: number
}

export default function TrendingTokens({
  onSelectToken
}: {
  onSelectToken: (mintAddress: string) => void
}) {
  const [trendingTokens, setTrendingTokens] = useState<TrendingToken[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [isPriceUpdating, setIsPriceUpdating] = useState<boolean>(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [isHovering, setIsHovering] = useState<boolean>(false)
  const scrollAnimationRef = useRef<number | null>(null)
  const [shouldScroll, setShouldScroll] = useState<boolean>(false)
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<string | null>(null)
  const [isChartOpen, setIsChartOpen] = useState<boolean>(false)
  const [isMobile, setIsMobile] = useState(false)
  const [axiomData, setAxiomData] = useState<Map<string, { data: AxiomTokenInfo; risk: RiskIndicators }>>(new Map())
  const [loadingAxiom, setLoadingAxiom] = useState<Set<string>>(new Set())

  // Fetch complete token data
  useEffect(() => {
    const fetchTrendingTokens = async () => {
      setIsLoading(true)
      setError(null)
      
      try {
        // Use the new filtered API endpoint specifically for TrendingTokens
        const response = await fetch('/api/trending/filtered')
        
        if (!response.ok) {
          throw new Error(`Failed to fetch trending tokens: ${response.status}`)
        }
        
        const data = await response.json()
        const tokens = data.tokens || []
        
        // Remove duplicate tokens with the same token_address
        const tokenMap = new Map<string, TrendingToken>()
        tokens.forEach((token: TrendingToken) => {
          if (!tokenMap.has(token.token_address)) {
            tokenMap.set(token.token_address, token)
          }
        })
        
        const uniqueTokens = Array.from(tokenMap.values())
        setTrendingTokens(uniqueTokens.slice(0, 10)) // Take top 10 unique tokens
      } catch (err) {
        console.error('Error fetching trending tokens:', err)
        setError('Failed to load trending tokens. Please try again later.')
      } finally {
        setIsLoading(false)
      }
    }
    
    fetchTrendingTokens()
    
    // Refresh every 5 minutes (300000 ms)
    const intervalId = setInterval(fetchTrendingTokens, 5 * 60 * 1000)
    
    return () => clearInterval(intervalId)
  }, [])

  // Fetch price updates every 10 seconds
  useEffect(() => {
    // Only start price updates after initial token data is loaded
    if (isLoading || error || trendingTokens.length === 0) return

    const updatePrices = async () => {
      setIsPriceUpdating(true)
      
      try {
        const response = await fetch('/api/trending/prices')
        
        if (!response.ok) {
          console.error(`Price update failed: ${response.status}`)
          return
        }
        
        const data = await response.json()
        const prices = data.prices || []
        
        if (prices.length === 0) return
        
        // Update prices and 5m changes in the existing tokens
        setTrendingTokens(currentTokens => {
          // First update all tokens with new prices
          const updatedTokens = currentTokens.map(token => {
            // Find matching price update
            const priceUpdate = prices.find(
              (p: TokenPrice) => p.token_address === token.token_address
            )
            
            if (priceUpdate) {
              // Return updated token with new price and 5m change
              return {
                ...token,
                price: priceUpdate.price,
                change_5m: priceUpdate.change_5m
              }
            }
            
            // Return original token if no update found
            return token
          })
          
          // Then filter out tokens with extreme negative price movement
          return updatedTokens.filter(token => token.change_5m > -0.4)
        })
      } catch (err) {
        console.error('Error updating token prices:', err)
        // Don't set error state for price updates to avoid disrupting the UI
      } finally {
        setIsPriceUpdating(false)
      }
    }

    // Run immediately for the first time
    updatePrices()
    
    // Update prices every 10 seconds
    const priceIntervalId = setInterval(updatePrices, 10 * 1000)
    
    return () => clearInterval(priceIntervalId)
  }, [isLoading, error, trendingTokens.length])

  // Check if scrolling is needed
  useEffect(() => {
    if (!isLoading && !error && scrollContainerRef.current) {
      const container = scrollContainerRef.current
      
      // Check if content height exceeds container height
      const needsScroll = container.scrollHeight > container.clientHeight
      setShouldScroll(needsScroll)
    }
  }, [isLoading, error, trendingTokens])

  // Auto-scroll animation
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer || isLoading || error || !shouldScroll || trendingTokens.length === 0) return

    const startScrollAnimation = () => {
      let lastTime = performance.now()
      const scrollSpeed = 0.5 // pixels per millisecond

      const animateScroll = (currentTime: number) => {
        if (isHovering) {
          scrollAnimationRef.current = requestAnimationFrame(animateScroll)
          return
        }
        
        const deltaTime = currentTime - lastTime
        lastTime = currentTime
        
        // Scroll down by the calculated amount
        scrollContainer.scrollTop += scrollSpeed * deltaTime
        
        // If we've reached the bottom, reset to top for infinite scroll
        if (scrollContainer.scrollTop >= (scrollContainer.scrollHeight - scrollContainer.clientHeight)) {
          scrollContainer.scrollTop = 0
        }
        
        scrollAnimationRef.current = requestAnimationFrame(animateScroll)
      }
      
      scrollAnimationRef.current = requestAnimationFrame(animateScroll)
    }

    // Start the animation after a short delay to ensure content is loaded
    const timeoutId = setTimeout(() => {
      startScrollAnimation()
    }, 1000)

    return () => {
      clearTimeout(timeoutId)
      if (scrollAnimationRef.current) {
        cancelAnimationFrame(scrollAnimationRef.current)
      }
    }
  }, [isLoading, error, trendingTokens, isHovering, shouldScroll])

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])
  
  const formatPercentage = (value: number) => {
    return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`
  }
  
  const formatVolume = (volume: number) => {
    if (volume >= 1000000) {
      return `$${(volume / 1000000).toFixed(2)}M`
    } else if (volume >= 1000) {
      return `$${(volume / 1000).toFixed(2)}K`
    }
    return `$${volume.toFixed(2)}`
  }

  const formatPrice = (price: number) => {
    if (price < 0.000001) return price.toExponential(2)
    if (price < 0.01) return price.toFixed(6)
    if (price < 1) return price.toFixed(4)
    if (price < 1000) return price.toFixed(2)
    return price.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }

  // Format timestamp as time ago (e.g. "2 hours ago", "3 days ago")
  const formatTimeAgo = (timestamp: number | undefined): string => {
    // console.log('Token timestamp received:', timestamp, typeof timestamp);
    
    if (!timestamp || isNaN(timestamp)) {
      // console.log('Invalid timestamp detected:', timestamp);
      return "Unknown time"
    }
    
    // Since we've normalized timestamps to seconds in the API
    // We need to convert to milliseconds for JavaScript Date
    const date = new Date(timestamp * 1000)
    // console.log('Converted date:', date.toString(), 'Valid:', !isNaN(date.getTime()));
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      // console.log('Date is invalid after conversion:', timestamp);
      return "Unknown time"
    }
    
    // Special case for future dates (invalid)
    const now = new Date()
    if (date > now) {
      // console.log('Date is in the future, likely invalid:', date);
      return "Recently"
    }
    
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)
    // console.log('Time difference in seconds:', seconds);
    
    // Handle timestamps too far in the past (likely invalid)
    if (seconds > 10 * 365 * 24 * 60 * 60) { // More than 10 years
      return "Unknown time"
    }
    
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    const months = Math.floor(days / 30)
    
    if (months > 0) {
      return months === 1 ? "1 month ago" : `${months} months ago`
    } else if (days > 0) {
      return days === 1 ? "1 day ago" : `${days} days ago`
    } else if (hours > 0) {
      return hours === 1 ? "1 hour ago" : `${hours} hours ago`
    } else if (minutes > 0) {
      return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`
    } else {
      return seconds <= 5 ? "just now" : `${seconds} seconds ago`
    }
  }

  const openTokenChart = (event: React.MouseEvent, token: TrendingToken) => {
    event.stopPropagation() // Prevent triggering the parent onClick
    onSelectToken(token.token_address)
  }

  // Fetch Axiom data for a token
  const fetchAxiomData = async (tokenAddress: string) => {
    if (loadingAxiom.has(tokenAddress) || axiomData.has(tokenAddress)) return
    
    setLoadingAxiom(prev => new Set(prev).add(tokenAddress))
    
    try {
      const result = await fetchAxiomTokenInfo(tokenAddress)
      if (result.success && result.data) {
        const risk = getRiskIndicators(result.data)
        setAxiomData(prev => new Map(prev).set(tokenAddress, { data: result.data!, risk }))
      } else if (result.requiresAuth) {
        // Handle authentication error gracefully
        console.warn('Axiom API requires authentication - risk data unavailable')
        // You could show a tooltip or notification here
      }
    } catch (error) {
      console.error(`Failed to fetch Axiom data for ${tokenAddress}:`, error)
    } finally {
      setLoadingAxiom(prev => {
        const newSet = new Set(prev)
        newSet.delete(tokenAddress)
        return newSet
      })
    }
  }

  // Add token to list in BulkTokenBuyer
  const handleAddToken = (token: TrendingToken) => {
    // We'll use the window object to dispatch a custom event
    const event = new CustomEvent('addTokenToList', {
      detail: { tokenAddress: token.token_address }
    })
    window.dispatchEvent(event)
  }

  const closeChart = () => {
    setIsChartOpen(false)
    setSelectedTokenAddress(null)
  }

  return (
    <div className="h-full">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xl font-bold text-white">Trending Tokens</h3>
        <div className="flex items-center">
          {isPriceUpdating && (
            <div className="w-3 h-3 mr-2 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
          )}
          <div className="text-sm text-gray-400">in last hour</div>
        </div>
      </div>
      <p className="text-xs text-gray-400 my-4 flex items-center">
        <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
        </svg>
        Click on a token to add it to buy list
      </p>

      <p className="text-xs text-gray-400 mb-4">disclaimer: Token information is for educational purposes only, not financial advice and always DYOR.</p>
      
      {isLoading && (
        <TokenSkeleton count={3} variant="trending" />
      )}
      
      {error && (
        <div className="bg-gray-800 text-gray-200 p-4 rounded-xl text-center">
          {error}
        </div>
      )}
      
      {!isLoading && !error && (
        <div 
          ref={scrollContainerRef}
          className={
            isMobile
              ? 'flex space-x-3 overflow-x-auto pb-2 scroll-smooth snap-x snap-mandatory'
              : `space-y-3 ${shouldScroll ? 'max-h-[600px] overflow-y-auto' : ''} pr-2 scroll-smooth`
          }
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
          style={isMobile ? { scrollbarWidth: 'thin', WebkitOverflowScrolling: 'touch' } : { scrollbarWidth: 'thin' }}
        >
          {trendingTokens.length === 0 ? (
            <div className="text-gray-400 text-center py-6">No trending tokens found</div>
          ) : (
            trendingTokens.map((token, index) => {
              // console.log(`Token ${token.token_symbol} (${token.token_address}):`, {
              //   created_at: token.created_at,
              //   type: typeof token.created_at
              // });
              
              return (
              <div 
                key={`${token.token_address}-${index}`}
                  className={
                    isMobile
                      ? 'min-w-full snap-center p-4 bg-gray-800 rounded-xl border border-gray-700 hover:border-gray-500 cursor-pointer transition-all duration-200'
                      : 'p-4 bg-gray-800 rounded-xl border border-gray-700 hover:border-gray-500 cursor-pointer transition-all duration-200'
                  }
                onClick={() => handleAddToken(token)}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-3">
                    <div className="relative">
                      <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-white font-bold overflow-hidden">
                        {token.logo_url ? (
                          <img 
                            src={token.logo_url} 
                            alt={token.token_symbol} 
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.currentTarget.onerror = null
                              e.currentTarget.src = ''
                              const parent = e.currentTarget.parentElement as HTMLElement | null
                              if (parent) {
                                parent.textContent = token.token_symbol.charAt(0)
                              }
                            }}
                          />
                        ) : (
                          token.token_symbol.charAt(0)
                        )}
                      </div>
                      <div className="absolute -top-1 -right-1 w-5 h-5 bg-gray-900 rounded-full flex items-center justify-center text-xs text-white">
                        {index + 1}
                      </div>
                    </div>
                    <div>
                      <div className="font-semibold text-white">{token.token_symbol}</div>
                        <div className="text-xs text-gray-400 truncate max-w-32">
                          {token.created_at ? formatTimeAgo(token.created_at) : 'New'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-white font-medium">
                      ${formatPrice(token.price)}
                    </div>
                    <div className={`text-xs ${token.change_5m >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {formatPercentage(token.change_5m)}
                    </div>
                  </div>
                </div>
                <div className="flex justify-between text-xs mt-2">
                  <div>
                    <span className="text-gray-400">1h: </span>
                    <span className={token.change_1h >= 0 ? 'text-green-400' : 'text-red-400'}>
                      {formatPercentage(token.change_1h)}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div>
                      <span className="text-gray-400">Vol: </span>
                      <span className="text-white">{formatVolume(token.volume_1h)}</span>
                    </div>
                    <button 
                      onClick={(e) => openTokenChart(e, token)}
                      className="ml-2 p-1 bg-gray-700 rounded hover:bg-gray-600 transition-colors"
                      title="View Chart"
                    >
                      <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Axiom Risk Indicators */}
                <div className="mt-2 pt-2 border-t border-gray-700">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Risk:</span>
                    <div className="flex items-center space-x-1">
                      {(() => {
                        const tokenAxiomData = axiomData.get(token.token_address)
                        const isLoading = loadingAxiom.has(token.token_address)
                        
                        if (isLoading) {
                          return (
                            <div className="flex items-center space-x-1">
                              <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                              <span className="text-gray-400">Loading...</span>
                            </div>
                          )
                        }
                        
                        if (!tokenAxiomData) {
                          return (
                            <button
                              onClick={() => fetchAxiomData(token.token_address)}
                              className="text-blue-400 hover:text-blue-300 text-xs"
                              title="Check token risk analysis (requires Axiom API access)"
                            >
                              Check Risk
                            </button>
                          )
                        }
                        
                        const { risk } = tokenAxiomData
                        const riskDisplay = formatRiskDisplay(risk.overallRisk)
                        
                        return (
                          <div className={`px-2 py-1 rounded text-xs font-medium ${riskDisplay.bg} ${riskDisplay.border} ${riskDisplay.color}`}>
                            {riskDisplay.text}
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                  
                  {/* Detailed risk breakdown (show on hover) */}
                  {(() => {
                    const tokenAxiomData = axiomData.get(token.token_address)
                    if (!tokenAxiomData) return null
                    
                    const { data, risk } = tokenAxiomData
                    const insiderDisplay = formatRiskDisplay(risk.insiderRisk)
                    const bundlerDisplay = formatRiskDisplay(risk.bundlerRisk)
                    
                    return (
                      <div className="mt-1 text-xs text-gray-400 space-y-1">
                        <div className="flex justify-between">
                          <span>Insiders: {data.insidersHoldPercent.toFixed(1)}%</span>
                          <span className={insiderDisplay.color}>{insiderDisplay.text}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Bundlers: {data.bundlersHoldPercent.toFixed(1)}%</span>
                          <span className={bundlerDisplay.color}>{bundlerDisplay.text}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Holders: {data.numHolders.toLocaleString()}</span>
                          <span className="text-gray-300">Fees: ${data.totalPairFeesPaid.toFixed(0)}</span>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}