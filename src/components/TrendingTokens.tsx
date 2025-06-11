'use client'

import React, { useEffect, useState } from 'react'

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

  useEffect(() => {
    const fetchTrendingTokens = async () => {
      setIsLoading(true)
      setError(null)
      
      try {
        const response = await fetch('https://api9.axiom.trade/meme-trending?timePeriod=5m', {
          headers: {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'accept-language': 'en-US,en;q=0.9',
            'cache-control': 'max-age=0',
            'cookie': 'auth-refresh-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZWZyZXNoVG9rZW5JZCI6IjlhNjIxNjIzLTJjN2QtNDIwNC04ZmIyLTFlODViYzY0MTNiOSIsImlhdCI6MTc0NTY2MjAxOH0.DHnI4iNiMRSSIqgaT3Lw8gAG62y53RRO_9H5uCwjblg; auth-access-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdXRoZW50aWNhdGVkVXNlcklkIjoiMGU5N2E1MTMtZTU5Ni00ZjFhLWIyNzUtMGMxZDY5MmU5Y2Q0IiwiaWF0IjoxNzQ5NjE4MDgwLCJleHAiOjE3NDk2MTkwNDB9.h53m9D3Kqwv0mHhZdorn5zCfWk4rTlh0-4SaLe-ZKso',
            'priority': 'u=0, i',
            'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1'
          }
        })
        
        if (!response.ok) {
          throw new Error(`Failed to fetch trending tokens: ${response.status}`)
        }
        
        const data = await response.json()
        const tokens = data.tokens || []
        setTrendingTokens(tokens.slice(0, 10)) // Take top 10 tokens
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

  return (
    <div className="bg-gray-900 rounded-2xl p-6 border border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-bold text-white">Trending Tokens</h3>
        <div className="text-sm text-gray-400">5m timeframe</div>
      </div>
      
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
        <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
          {trendingTokens.length === 0 ? (
            <div className="text-gray-400 text-center py-6">No trending tokens found</div>
          ) : (
            trendingTokens.map((token, index) => (
              <div 
                key={token.token_address}
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
                      ${token.price < 0.01 ? token.price.toExponential(2) : token.price.toFixed(token.price < 1 ? 4 : 2)}
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
                  <div>
                    <span className="text-gray-400">Vol: </span>
                    <span className="text-white">{formatVolume(token.volume_1h)}</span>
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