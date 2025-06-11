'use client'

import React, { useEffect, useState, useRef } from 'react'

interface TrendingToken {
  token_symbol: string
  token_address: string
  price: number
  change_1h: number
  change_5m: number
  volume_1h: number
  logo_url?: string
}

export default function TrendingTokens({
  onSelectToken
}: {
  onSelectToken: (mintAddress: string) => void
}) {
  const [trendingTokens, setTrendingTokens] = useState<TrendingToken[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [isHovering, setIsHovering] = useState<boolean>(false)
  const scrollAnimationRef = useRef<number | null>(null)
  const [shouldScroll, setShouldScroll] = useState<boolean>(false)

  useEffect(() => {
    const fetchTrendingTokens = async () => {
      setIsLoading(true)
      setError(null)
      
      try {
        // Use our local API endpoint instead of calling Jupiter API directly
        const response = await fetch('/api/trending')
        
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
    
    // Refresh every 2 minutes
    const intervalId = setInterval(fetchTrendingTokens, 2 * 60 * 1000)
    
    return () => clearInterval(intervalId)
  }, [])

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

  const openTokenChart = (event: React.MouseEvent, tokenAddress: string) => {
    event.stopPropagation() // Prevent triggering the parent onClick
    window.open(`https://axiom.trade/@reloadsol`, '_blank')
  }

  return (
    <div className="h-full">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xl font-bold text-white">Trending Tokens</h3>
        <div className="text-sm text-gray-400">in last hour</div>
      </div>
      <p className="text-xs text-gray-400 mb-4">disclaimer: Token information is for educational purposes only, not financial advice and always DYOR.</p>
      
      {isLoading && (
        <div className="flex justify-center items-center py-10">
          <div className="w-10 h-10 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
      
      {error && (
        <div className="bg-gray-800 text-gray-200 p-4 rounded-xl text-center">
          {error}
        </div>
      )}
      
      {!isLoading && !error && (
        <div 
          ref={scrollContainerRef}
          className={`space-y-3 ${shouldScroll ? 'max-h-[600px] overflow-y-auto' : ''} pr-2 scroll-smooth`}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
          style={{ scrollbarWidth: 'thin' }}
        >
          {trendingTokens.length === 0 ? (
            <div className="text-gray-400 text-center py-6">No trending tokens found</div>
          ) : (
            trendingTokens.map((token, index) => (
              <div 
                key={`${token.token_address}-${index}`}
                onClick={() => onSelectToken(token.token_address)}
                className="p-4 bg-gray-800 rounded-xl border border-gray-700 hover:border-gray-500 cursor-pointer transition-all duration-200"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-3">
                    <div className="relative">
                      <div className="w-10 h-10 bg-gray-700 rounded-full flex items-center justify-center text-white font-bold overflow-hidden">
                        {token.logo_url ? (
                          <img 
                            src={token.logo_url} 
                            alt={token.token_symbol} 
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.currentTarget.onerror = null
                              e.currentTarget.src = ''
                              e.currentTarget.parentElement!.textContent = token.token_symbol.charAt(0)
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
                      <div className="text-xs text-gray-400 font-mono truncate max-w-32">
                        {`${token.token_address.slice(0, 4)}...${token.token_address.slice(-4)}`}
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
                      onClick={(e) => openTokenChart(e, token.token_address)}
                      className="ml-2 p-1 bg-gray-700 rounded hover:bg-gray-600 transition-colors"
                      title="View on Axiom"
                    >
                      <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
} 