'use client'

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useState, useCallback } from 'react'

interface TokenStats {
  basic: {
    address: string
    symbol: string
    name: string
    decimals: number
    logoURI?: string
  }
  price?: {
    current: number
    change24h: number
    volume24h: number
    marketCap: number
  }
  age?: {
    ageInDays: number
    ageCategory: 'NEW' | 'RECENT' | 'ESTABLISHED' | 'OLD'
    ageDisplay: string
    createdAt: string
  }
  trading?: {
    holders: number
    totalSupply: string
    liquidity: number
  }
  metadata?: {
    description?: string
    website?: string
    twitter?: string
    telegram?: string
  }
  tradeTest?: {
    buyTest: {
      success: boolean
      bestProvider?: string
      outputAmount?: string
      responseTime?: number
      priceComparison?: {
        providers: Record<string, {
          success: boolean
          outputAmount: string
          priceImpact: string
          fee?: {
            totalFeeLamports: number
            feePercentage: number
          }
          responseTime: number
          error?: string
        }>
        bestPrice: {
          provider: string
          outputAmount: string
          advantage: string
        }
        worstPrice: {
          provider: string
          outputAmount: string
          disadvantage: string
        }
        avgPriceImpact: string
        priceSpread: string
      }
    }
    sellTest: {
      success: boolean
      bestProvider?: string
      outputAmount?: string
      responseTime?: number
      priceComparison?: {
        providers: Record<string, {
          success: boolean
          outputAmount: string
          priceImpact: string
          fee?: {
            totalFeeLamports: number
            feePercentage: number
          }
          responseTime: number
          error?: string
        }>
        bestPrice: {
          provider: string
          outputAmount: string
          advantage: string
        }
        worstPrice: {
          provider: string
          outputAmount: string
          disadvantage: string
        }
        avgPriceImpact: string
        priceSpread: string
      }
    }
  }
}

interface RandomToken {
  address: string
  symbol: string
  name: string
  decimals: number
  tags?: string[]
  logoURI?: string
  tradeTest?: TokenStats['tradeTest']
  currentPrice?: number | null
}

const TokenSearchInterface: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'random' | 'search'>('random')
  const [randomTokens, setRandomTokens] = useState<RandomToken[]>([])
  const [searchAddress, setSearchAddress] = useState('')
  const [searchResult, setSearchResult] = useState<TokenStats | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testingProgress, setTestingProgress] = useState<string>('')

  // Test trade operations for a token
  const testTokenTrade = useCallback(async (tokenAddress: string, tokenSymbol: string): Promise<TokenStats['tradeTest']> => {
    try {
      console.log(`🧪 Starting trade test for ${tokenSymbol} (${tokenAddress})`)
      setTestingProgress(`Testing ${tokenSymbol} - Buy operations...`)
      
      // Test BUY operation: SOL → Token
      const buyRequestBody = {
        inputMint: 'So11111111111111111111111111111111111111112', // SOL
        outputMint: tokenAddress,
        amount: '100000000', // 0.1 SOL
        slippageBps: 100,
        userPublicKey: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'
      }
      
      console.log(`🟢 BUY Test Request:`, buyRequestBody)
      
      const buyResponse = await fetch('/api/trade/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buyRequestBody)
      })

      console.log(`🟢 BUY Response Status: ${buyResponse.status} ${buyResponse.statusText}`)
      
      if (!buyResponse.ok) {
        console.error(`🟢 BUY Request failed with status ${buyResponse.status}`)
        const errorText = await buyResponse.text()
        console.error(`🟢 BUY Error response:`, errorText)
      }

      const buyData = await buyResponse.json()
      console.log(`🟢 BUY Response Data:`, buyData)
      
      setTestingProgress(`Testing ${tokenSymbol} - Sell operations...`)
      
      // Test SELL operation: Token → SOL
      const sellRequestBody = {
        inputMint: tokenAddress,
        outputMint: 'So11111111111111111111111111111111111111112', // SOL
        amount: '10000000', // 0.01 tokens (assuming 9 decimals)
        slippageBps: 200,
        userPublicKey: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'
      }
      
      console.log(`🔴 SELL Test Request:`, sellRequestBody)
      
      const sellResponse = await fetch('/api/trade/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sellRequestBody)
      })

      console.log(`🔴 SELL Response Status: ${sellResponse.status} ${sellResponse.statusText}`)
      
      if (!sellResponse.ok) {
        console.error(`🔴 SELL Request failed with status ${sellResponse.status}`)
        const errorText = await sellResponse.text()
        console.error(`🔴 SELL Error response:`, errorText)
      }

      const sellData = await sellResponse.json()
      console.log(`🔴 SELL Response Data:`, sellData)

      // Process results into our format
      const processBuyTest = () => {
        console.log(`🟢 Processing BUY test data:`, {
          hasQuotes: !!buyData.quotes,
          quotesLength: buyData.quotes?.length || 0,
          hasBestQuote: !!buyData.bestQuote,
          summary: buyData.summary,
          explicitSuccess: buyData.success
        })
        
        // The API doesn't return explicit success field, check for bestQuote and quotes instead
        const hasBestQuote = buyData.bestQuote && buyData.bestQuote.success !== false
        const hasValidQuotes = buyData.quotes && buyData.quotes.length > 0
        
        if (!hasBestQuote || !hasValidQuotes) {
          console.warn(`🟢 BUY test failed - bestQuote: ${!!buyData.bestQuote}, validQuotes: ${hasValidQuotes}`)
          return { success: false }
        }

        const providers: Record<string, any> = {}
        const amounts: number[] = []
        
        console.log(`🟢 Processing ${buyData.quotes?.length || 0} BUY quotes:`)
        
        buyData.quotes?.forEach((quote: any, index: number) => {
          console.log(`🟢 Quote ${index + 1}:`, {
            provider: quote.provider,
            success: quote.success,
            outAmount: quote.outAmount,
            priceImpactPct: quote.priceImpactPct,
            error: quote.error
          })
          
          providers[quote.provider] = {
            success: quote.success,
            outputAmount: quote.outAmount || '0',
            priceImpact: quote.priceImpactPct || '0',
            fee: quote.fees,
            responseTime: quote.responseTime || 0,
            error: quote.error
          }
          
          if (quote.success && quote.outAmount) {
            amounts.push(parseFloat(quote.outAmount))
          }
        })
        
        console.log(`🟢 Valid amounts extracted:`, amounts)

        if (amounts.length === 0) {
          return { success: false }
        }

        const avgAmount = amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length
        const bestAmount = Math.max(...amounts)
        const worstAmount = Math.min(...amounts)

        const bestQuote = buyData.quotes?.find((q: any) => parseFloat(q.outAmount) === bestAmount)
        const worstQuote = buyData.quotes?.find((q: any) => parseFloat(q.outAmount) === worstAmount)

        const bestAdvantage = avgAmount > 0 ? (((bestAmount - avgAmount) / avgAmount) * 100).toFixed(2) : '0'
        const worstDisadvantage = avgAmount > 0 ? (((avgAmount - worstAmount) / avgAmount) * 100).toFixed(2) : '0'
        const priceSpread = worstAmount > 0 ? (((bestAmount - worstAmount) / worstAmount) * 100).toFixed(2) : '0'

        const priceImpacts = buyData.quotes?.map((q: any) => parseFloat(q.priceImpactPct)).filter((p: number) => !isNaN(p)) || []
        const avgPriceImpact = priceImpacts.length > 0 
          ? (priceImpacts.reduce((sum: number, impact: number) => sum + impact, 0) / priceImpacts.length).toFixed(4)
          : '0'

        return {
          success: true,
          bestProvider: bestQuote?.provider,
          outputAmount: bestQuote?.outAmount,
          responseTime: buyData.summary?.averageResponseTime || 0,
          priceComparison: {
            providers,
            bestPrice: {
              provider: bestQuote?.provider || '',
              outputAmount: bestQuote?.outAmount || '0',
              advantage: `${bestAdvantage}%`
            },
            worstPrice: {
              provider: worstQuote?.provider || '',
              outputAmount: worstQuote?.outAmount || '0',
              disadvantage: `${worstDisadvantage}%`
            },
            avgPriceImpact: `${avgPriceImpact}%`,
            priceSpread: `${priceSpread}%`
          }
        }
      }

      const processSellTest = () => {
        console.log(`🔴 Processing SELL test data:`, {
          hasQuotes: !!sellData.quotes,
          quotesLength: sellData.quotes?.length || 0,
          hasBestQuote: !!sellData.bestQuote,
          summary: sellData.summary,
          explicitSuccess: sellData.success
        })
        
        // The API doesn't return explicit success field, check for bestQuote and quotes instead
        const hasBestQuote = sellData.bestQuote && sellData.bestQuote.success !== false
        const hasValidQuotes = sellData.quotes && sellData.quotes.length > 0
        
        if (!hasBestQuote || !hasValidQuotes) {
          console.warn(`🔴 SELL test failed - bestQuote: ${!!sellData.bestQuote}, validQuotes: ${hasValidQuotes}`)
          return { success: false }
        }

        const providers: Record<string, any> = {}
        const amounts: number[] = []
        
        console.log(`🔴 Processing ${sellData.quotes?.length || 0} SELL quotes:`)
        
        sellData.quotes?.forEach((quote: any, index: number) => {
          console.log(`🔴 Quote ${index + 1}:`, {
            provider: quote.provider,
            success: quote.success,
            outAmount: quote.outAmount,
            priceImpactPct: quote.priceImpactPct,
            error: quote.error
          })
          
          providers[quote.provider] = {
            success: quote.success,
            outputAmount: quote.outAmount || '0',
            priceImpact: quote.priceImpactPct || '0',
            fee: quote.fees,
            responseTime: quote.responseTime || 0,
            error: quote.error
          }
          
          if (quote.success && quote.outAmount) {
            amounts.push(parseFloat(quote.outAmount))
          }
        })
        
        console.log(`🔴 Valid amounts extracted:`, amounts)

        if (amounts.length === 0) {
          return { success: false }
        }

        const avgAmount = amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length
        const bestAmount = Math.max(...amounts)
        const worstAmount = Math.min(...amounts)

        const bestQuote = sellData.quotes?.find((q: any) => parseFloat(q.outAmount) === bestAmount)
        const worstQuote = sellData.quotes?.find((q: any) => parseFloat(q.outAmount) === worstAmount)

        const bestAdvantage = avgAmount > 0 ? (((bestAmount - avgAmount) / avgAmount) * 100).toFixed(2) : '0'
        const worstDisadvantage = avgAmount > 0 ? (((avgAmount - worstAmount) / avgAmount) * 100).toFixed(2) : '0'
        const priceSpread = worstAmount > 0 ? (((bestAmount - worstAmount) / worstAmount) * 100).toFixed(2) : '0'

        const priceImpacts = sellData.quotes?.map((q: any) => parseFloat(q.priceImpactPct)).filter((p: number) => !isNaN(p)) || []
        const avgPriceImpact = priceImpacts.length > 0 
          ? (priceImpacts.reduce((sum: number, impact: number) => sum + impact, 0) / priceImpacts.length).toFixed(4)
          : '0'

        return {
          success: true,
          bestProvider: bestQuote?.provider,
          outputAmount: bestQuote?.outAmount,
          responseTime: sellData.summary?.averageResponseTime || 0,
          priceComparison: {
            providers,
            bestPrice: {
              provider: bestQuote?.provider || '',
              outputAmount: bestQuote?.outAmount || '0',
              advantage: `${bestAdvantage}%`
            },
            worstPrice: {
              provider: worstQuote?.provider || '',
              outputAmount: worstQuote?.outAmount || '0',
              disadvantage: `${worstDisadvantage}%`
            },
            avgPriceImpact: `${avgPriceImpact}%`,
            priceSpread: `${priceSpread}%`
          }
        }
      }

      const buyTestResult = processBuyTest()
      const sellTestResult = processSellTest()
      
      console.log(`🧪 Final test results for ${tokenSymbol}:`, {
        buyTest: buyTestResult,
        sellTest: sellTestResult
      })

      return {
        buyTest: buyTestResult,
        sellTest: sellTestResult
      }

    } catch (error) {
      console.error(`❌ Trade test failed for ${tokenSymbol}:`, error)
      console.error(`❌ Error details:`, {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace'
      })
      return {
        buyTest: { success: false },
        sellTest: { success: false }
      }
    }
  }, [])

  // Test all random tokens
  const testAllRandomTokens = useCallback(async () => {
    if (randomTokens.length === 0) return

    setIsLoading(true)
    setError(null)
    setTestingProgress('Starting trade tests...')

    try {
      const updatedTokens: RandomToken[] = []

      for (let i = 0; i < randomTokens.length; i++) {
        const token = randomTokens[i]
        setTestingProgress(`Testing ${i + 1}/${randomTokens.length}: ${token.symbol}`)
        
        const tradeTest = await testTokenTrade(token.address, token.symbol)
        
        updatedTokens.push({
          ...token,
          tradeTest
        })

        // Wait between tests to avoid rate limiting
        if (i < randomTokens.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      }

      setRandomTokens(updatedTokens)
      setTestingProgress('')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to test tokens')
      setTestingProgress('')
    } finally {
      setIsLoading(false)
    }
  }, [randomTokens, testTokenTrade])

  // Fetch price data from our API
  const fetchTokenPrice = useCallback(async (tokenAddress: string) => {
    try {
      const response = await fetch('/api/tokens/prices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tokens: [tokenAddress]
        })
      })

      if (!response.ok) {
        throw new Error('Failed to fetch price')
      }

      const data = await response.json()
      return data.prices[tokenAddress] || null
    } catch (error) {
      console.error('Price fetch error:', error)
      return null
    }
  }, [])

  // Refresh price for current search result
  const refreshPrice = useCallback(async () => {
    if (!searchResult) return
    
    setTestingProgress(`Refreshing price for ${searchResult.basic.symbol}...`)
    
    try {
      const currentPrice = await fetchTokenPrice(searchResult.basic.address)
      
      setSearchResult(prev => {
        if (!prev) return null
        
        return {
          ...prev,
          price: prev.price ? {
            ...prev.price,
            current: currentPrice || prev.price.current || 0
          } : {
            current: currentPrice || 0,
            change24h: 0,
            volume24h: 0,
            marketCap: 0
          }
        }
      })
      
      setTestingProgress('')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to refresh price')
      setTestingProgress('')
    }
  }, [searchResult, fetchTokenPrice])

  // Test single token (for search results)
  const testSingleToken = useCallback(async (token: TokenStats) => {
    setIsLoading(true)
    setTestingProgress(`Testing ${token.basic.symbol}...`)
    
    try {
      const tradeTest = await testTokenTrade(token.basic.address, token.basic.symbol)
      setSearchResult({
        ...token,
        tradeTest
      })
      setTestingProgress('')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to test token')
      setTestingProgress('')
    } finally {
      setIsLoading(false)
    }
  }, [testTokenTrade])

  // Fetch random tokens
  const fetchRandomTokens = useCallback(async (count: number = 10) => {
    setIsLoading(true)
    setError(null)
    setTestingProgress(`Fetching ${count} random tokens...`)
    
    try {
      const response = await fetch(`/api/tokens/random?count=${count}`)
      const data = await response.json()
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch random tokens')
      }
      
      // Fetch prices for all tokens at once using our price API
      setTestingProgress(`Getting prices for ${count} tokens...`)
      const tokenAddresses = data.tokens.map((token: RandomToken) => token.address)
      
      const priceResponse = await fetch('/api/tokens/prices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          tokens: tokenAddresses
        })
      })
      
      let prices: Record<string, number> = {}
      if (priceResponse.ok) {
        const priceData = await priceResponse.json()
        prices = priceData.prices || {}
        console.log(`✅ Fetched prices for ${Object.keys(prices).length}/${tokenAddresses.length} tokens`, {
          cached: priceData.cached_tokens,
          fresh: priceData.fresh_tokens,
          rateLimit: priceData.rate_limit_remaining
        })
      }
      
      // Enhance tokens with price data
      const tokensWithPrices = data.tokens.map((token: RandomToken) => ({
        ...token,
        currentPrice: prices[token.address] || null
      }))
      
      setRandomTokens(tokensWithPrices)
      setTestingProgress('')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to fetch random tokens')
      setTestingProgress('')
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Search specific token
  const searchToken = useCallback(async () => {
    if (!searchAddress.trim()) {
      setError('Please enter a token address')
      return
    }
    
    setIsLoading(true)
    setError(null)
    setSearchResult(null)
    setTestingProgress(`Searching for ${searchAddress.slice(0, 8)}...`)
    
    try {
      const response = await fetch(`/api/tokens/search?address=${encodeURIComponent(searchAddress.trim())}`)
      const data = await response.json()
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to search token')
      }
      
      // Fetch current price for the token
      setTestingProgress(`Getting price for ${data.token.basic.symbol}...`)
      const currentPrice = await fetchTokenPrice(data.token.basic.address)
      
      // Enhance token data with current price
      const enhancedToken = {
        ...data.token,
        price: {
          ...data.token.price,
          current: currentPrice || data.token.price?.current || 0
        }
      }
      
      setSearchResult(enhancedToken)
      setTestingProgress('')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to search token')
      setTestingProgress('')
    } finally {
      setIsLoading(false)
    }
  }, [searchAddress, fetchTokenPrice])

  // Format large numbers
  const formatNumber = (num: number): string => {
    if (num >= 1_000_000_000) {
      return `${(num / 1_000_000_000).toFixed(2)}B`
    } else if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(2)}K`
    }
    return num.toLocaleString()
  }

  // Get age badge color
  const getAgeBadgeColor = (category: string): string => {
    switch (category) {
      case 'NEW': return 'bg-green-600 text-green-100'
      case 'RECENT': return 'bg-blue-600 text-blue-100'
      case 'ESTABLISHED': return 'bg-yellow-600 text-yellow-100'
      case 'OLD': return 'bg-gray-600 text-gray-100'
      default: return 'bg-gray-600 text-gray-100'
    }
  }

  // Get provider icon
  const getProviderIcon = (provider: string): string => {
    switch (provider) {
      case 'jupiter': return '🪐'
      case 'dflow': return '🌊'
      case 'solana-tracker': return '📊'
      case 'gmgn': return '🤖'
      default: return '❓'
    }
  }

  return (
    <div className="bg-black border border-gray-700 rounded-lg p-6">
      <h2 className="text-2xl font-bold mb-6 text-white flex items-center gap-2">
        🔍 Token Discovery & Trade Testing
      </h2>

      {/* Tab Navigation */}
      <div className="flex space-x-2 mb-6">
        <button
          onClick={() => setActiveTab('random')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'random'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }`}
        >
          🎲 Random Tokens
        </button>
        <button
          onClick={() => setActiveTab('search')}
          className={`px-4 py-2 rounded-lg font-medium transition-colors ${
            activeTab === 'search'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }`}
        >
          🔍 Search Token
        </button>
      </div>

      {/* Progress Indicator */}
      {testingProgress && (
        <div className="bg-blue-900 border border-blue-600 rounded-lg p-4 mb-6">
          <p className="text-blue-200">⏳ {testingProgress}</p>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="bg-red-900 border border-red-600 rounded-lg p-4 mb-6">
          <p className="text-red-200">❌ {error}</p>
        </div>
      )}

      {/* Random Tokens Tab */}
      {activeTab === 'random' && (
        <div>
          <div className="flex items-center gap-4 mb-6">
            <button
              onClick={() => fetchRandomTokens(5)}
              disabled={isLoading}
              className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >
              {isLoading ? '⏳ Loading...' : '🎲 Get 5 Random Tokens'}
            </button>
            <button
              onClick={() => fetchRandomTokens(10)}
              disabled={isLoading}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white px-4 py-2 rounded-lg font-medium transition-colors"
            >
              {isLoading ? '⏳ Loading...' : '🎯 Get 10 Random Tokens'}
            </button>
            {randomTokens.length > 0 && (
              <button
                onClick={testAllRandomTokens}
                disabled={isLoading}
                className="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 text-white px-4 py-2 rounded-lg font-medium transition-colors"
              >
                {isLoading ? '⏳ Testing...' : '🧪 Test All (Buy & Sell)'}
              </button>
            )}
          </div>

          {/* Random Tokens Grid */}
          {randomTokens.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {randomTokens.map((token, index) => (
                <div key={token.address} className="bg-gray-900 border border-gray-700 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      {token.logoURI ? (
                        <OptimizedImage src={token.logoURI} alt={token.symbol} className="w-8 h-8 rounded-full" />
                      ) : (
                        <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center">
                          <span className="text-xs text-gray-300">🪙</span>
                        </div>
                      )}
                      <div>
                        <h4 className="font-bold text-white">{token.symbol}</h4>
                        <p className="text-sm text-gray-400">{token.name}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Address:</span>
                      <span className="text-white font-mono text-xs">
                        {token.address.slice(0, 6)}...{token.address.slice(-4)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Decimals:</span>
                      <span className="text-white">{token.decimals}</span>
                    </div>
                    
                    {/* Price Info */}
                    <div className="flex justify-between">
                      <span className="text-gray-400">Current Price:</span>
                      <span className="text-white">
                        {typeof token.currentPrice === 'number' 
                          ? `$${token.currentPrice.toFixed(6)}`
                          : token.currentPrice === null
                          ? '💰 Fetching...'
                          : 'N/A'
                        }
                      </span>
                    </div>
                    
                    {/* Trade Test Results */}
                    {token.tradeTest && (
                      <div className="mt-3 space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                          <div className={`p-2 rounded text-center text-xs ${
                            token.tradeTest.buyTest.success ? 'bg-green-800 text-green-200' : 'bg-red-800 text-red-200'
                          }`}>
                            🟢 BUY {token.tradeTest.buyTest.success ? '✅' : '❌'}
                          </div>
                          <div className={`p-2 rounded text-center text-xs ${
                            token.tradeTest.sellTest.success ? 'bg-green-800 text-green-200' : 'bg-red-800 text-red-200'
                          }`}>
                            🔴 SELL {token.tradeTest.sellTest.success ? '✅' : '❌'}
                          </div>
                        </div>
                        
                        {token.tradeTest.buyTest.success && token.tradeTest.buyTest.priceComparison && (
                          <div className="text-xs text-gray-300">
                            <p>Best Buy: {getProviderIcon(token.tradeTest.buyTest.priceComparison.bestPrice.provider)} {token.tradeTest.buyTest.priceComparison.bestPrice.provider}</p>
                            <p>Price Spread: {token.tradeTest.buyTest.priceComparison.priceSpread}</p>
                          </div>
                        )}
                        
                        {token.tradeTest.sellTest.success && token.tradeTest.sellTest.priceComparison && (
                          <div className="text-xs text-gray-300">
                            <p>Best Sell: {getProviderIcon(token.tradeTest.sellTest.priceComparison.bestPrice.provider)} {token.tradeTest.sellTest.priceComparison.bestPrice.provider}</p>
                            <p>Price Spread: {token.tradeTest.sellTest.priceComparison.priceSpread}</p>
                          </div>
                        )}
                      </div>
                    )}

                    {token.tags && token.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {token.tags.slice(0, 3).map((tag, i) => (
                          <span key={i} className="bg-blue-800 text-blue-200 px-2 py-1 rounded-full text-xs">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    
                    <button
                      onClick={() => {
                        setSearchAddress(token.address)
                        setActiveTab('search')
                      }}
                      className="w-full mt-3 bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded text-sm transition-colors"
                    >
                      📊 View Details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search Token Tab */}
      {activeTab === 'search' && (
        <div>
          <div className="flex gap-3 mb-6">
            <input
              type="text"
              value={searchAddress}
              onChange={(e) => setSearchAddress(e.target.value)}
              placeholder="Enter token address (e.g., EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)"
              className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-400 focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={searchToken}
              disabled={isLoading || !searchAddress.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white px-6 py-2 rounded-lg font-medium transition-colors"
            >
              {isLoading ? '⏳' : '🔍'} Search
            </button>
          </div>

          {/* Search Results */}
          {searchResult && (
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-6">
              {/* Basic Info Header */}
              <div className="flex items-start justify-between mb-6">
                <div className="flex items-center gap-4">
                  {searchResult.basic.logoURI ? (
                    <OptimizedImage src={searchResult.basic.logoURI} alt={searchResult.basic.symbol} className="w-16 h-16 rounded-full" />
                  ) : (
                    <div className="w-16 h-16 bg-gray-700 rounded-full flex items-center justify-center">
                      <span className="text-2xl">🪙</span>
                    </div>
                  )}
                  <div>
                    <h3 className="text-2xl font-bold text-white">{searchResult.basic.symbol}</h3>
                    <p className="text-lg text-gray-300">{searchResult.basic.name}</p>
                    <p className="text-sm text-gray-500 font-mono">
                      {searchResult.basic.address.slice(0, 8)}...{searchResult.basic.address.slice(-8)}
                    </p>
                  </div>
                </div>
                
                <div className="flex gap-2">
                  {searchResult.age && (
                    <div className={`px-3 py-2 rounded-full text-sm font-bold ${getAgeBadgeColor(searchResult.age.ageCategory)}`}>
                      🕐 {searchResult.age.ageDisplay}
                    </div>
                  )}
                  
                  <button
                    onClick={() => testSingleToken(searchResult)}
                    disabled={isLoading}
                    className="bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                  >
                    {isLoading ? '⏳' : '🧪'} Test Trade
                  </button>
                </div>
              </div>

              {/* Basic Stats Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
                {/* Price Info */}
                {searchResult.price && (
                  <div className="bg-green-900 border border-green-700 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-lg font-bold text-green-200">💰 Price Data</h4>
                      <button
                        onClick={refreshPrice}
                        disabled={!!testingProgress}
                        className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white px-3 py-1 rounded text-sm font-medium transition-colors"
                      >
                        🔄 Refresh
                      </button>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-green-300">Current Price:</span>
                        <span className="text-white font-bold">
                          ${typeof searchResult.price.current === 'number' ? searchResult.price.current.toFixed(6) : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-green-300">24h Change:</span>
                        <span className={`font-bold ${(searchResult.price.change24h || 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {typeof searchResult.price.change24h === 'number' 
                            ? `${searchResult.price.change24h >= 0 ? '+' : ''}${searchResult.price.change24h.toFixed(2)}%`
                            : 'N/A'
                          }
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-green-300">Market Cap:</span>
                        <span className="text-white">
                          ${typeof searchResult.price.marketCap === 'number' ? formatNumber(searchResult.price.marketCap) : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-green-300">24h Volume:</span>
                        <span className="text-white">
                          ${typeof searchResult.price.volume24h === 'number' ? formatNumber(searchResult.price.volume24h) : 'N/A'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Trading Info */}
                {searchResult.trading && (
                  <div className="bg-blue-900 border border-blue-700 rounded-lg p-4">
                    <h4 className="text-lg font-bold text-blue-200 mb-3">📈 Trading Data</h4>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-blue-300">Holders:</span>
                        <span className="text-white">
                          {typeof searchResult.trading.holders === 'number' ? formatNumber(searchResult.trading.holders) : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-blue-300">Total Supply:</span>
                        <span className="text-white">
                          {searchResult.trading.totalSupply ? formatNumber(parseInt(searchResult.trading.totalSupply)) : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-blue-300">Liquidity:</span>
                        <span className="text-white">
                          ${typeof searchResult.trading.liquidity === 'number' ? formatNumber(searchResult.trading.liquidity) : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-blue-300">Decimals:</span>
                        <span className="text-white">{searchResult.basic.decimals}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Age & Metadata */}
                <div className="bg-purple-900 border border-purple-700 rounded-lg p-4">
                  <h4 className="text-lg font-bold text-purple-200 mb-3">ℹ️ Token Info</h4>
                  <div className="space-y-2 text-sm">
                    {searchResult.age && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-purple-300">Age Category:</span>
                          <span className="text-white font-bold">{searchResult.age.ageCategory}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-purple-300">Days Old:</span>
                          <span className="text-white">{searchResult.age.ageInDays}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-purple-300">Created:</span>
                          <span className="text-white">
                            {new Date(searchResult.age.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </>
                    )}
                    {searchResult.metadata?.description && (
                      <div className="mt-3">
                        <span className="text-purple-300 text-xs">Description:</span>
                        <p className="text-white text-xs mt-1">{searchResult.metadata.description}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Trade Test Results */}
              {searchResult.tradeTest && (
                <div className="border-t border-gray-700 pt-6">
                  <h4 className="text-xl font-bold text-white mb-4">🧪 Trade Test Results</h4>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    
                    {/* Buy Test */}
                    <div className={`p-4 rounded-lg border-2 ${
                      searchResult.tradeTest.buyTest.success ? 'bg-green-900 border-green-600' : 'bg-red-900 border-red-600'
                    }`}>
                      <h5 className="font-bold text-lg mb-3 text-white">
                        🟢 BUY Test {searchResult.tradeTest.buyTest.success ? '✅' : '❌'}
                      </h5>
                      
                      {searchResult.tradeTest.buyTest.success && searchResult.tradeTest.buyTest.priceComparison ? (
                        <div className="space-y-3 text-white">
                          {/* Best Price Summary */}
                          <div className="bg-green-800 p-3 rounded">
                            <p className="text-sm text-green-200">🏆 Best Price</p>
                            <p><strong>Provider:</strong> {getProviderIcon(searchResult.tradeTest.buyTest.priceComparison.bestPrice.provider)} {searchResult.tradeTest.buyTest.priceComparison.bestPrice.provider}</p>
                            <p><strong>Amount:</strong> {
                              searchResult.tradeTest.buyTest.priceComparison.bestPrice.outputAmount
                                ? parseFloat(searchResult.tradeTest.buyTest.priceComparison.bestPrice.outputAmount).toFixed(6)
                                : 'N/A'
                            } tokens</p>
                            <p><strong>Advantage:</strong> <span className="text-green-300">{searchResult.tradeTest.buyTest.priceComparison.bestPrice.advantage}</span></p>
                          </div>
                          
                          {/* Price Metrics */}
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-gray-800 p-2 rounded">
                              <p className="text-gray-400">Price Spread</p>
                              <p className="font-bold">{searchResult.tradeTest.buyTest.priceComparison.priceSpread}</p>
                            </div>
                            <div className="bg-gray-800 p-2 rounded">
                              <p className="text-gray-400">Avg Impact</p>
                              <p className="font-bold">{searchResult.tradeTest.buyTest.priceComparison.avgPriceImpact}</p>
                            </div>
                          </div>

                          {/* Provider Details */}
                          <div className="space-y-2">
                            <p className="text-sm font-bold text-green-200">Provider Breakdown:</p>
                            {Object.entries(searchResult.tradeTest.buyTest.priceComparison.providers).map(([provider, data]) => (
                              <div key={provider} className={`p-2 rounded text-xs ${
                                data.success ? 'bg-green-800' : 'bg-red-800'
                              }`}>
                                <div className="flex justify-between items-center">
                                  <span className="font-bold">{getProviderIcon(provider)} {provider}</span>
                                  <span className={data.success ? 'text-green-200' : 'text-red-200'}>
                                    {data.success ? '✅' : '❌'}
                                  </span>
                                </div>
                                {data.success && (
                                  <div className="mt-1 space-y-1">
                                    <div className="flex justify-between">
                                      <span>Amount:</span>
                                      <span>{data.outputAmount ? parseFloat(data.outputAmount).toFixed(6) : 'N/A'} tokens</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span>Impact:</span>
                                      <span>{data.priceImpact}%</span>
                                    </div>
                                    {data.fee && (
                                      <div className="flex justify-between">
                                        <span>Fee:</span>
                                        <span>{typeof data.fee.feePercentage === 'number' ? data.fee.feePercentage.toFixed(3) : 'N/A'}%</span>
                                      </div>
                                    )}
                                    <div className="flex justify-between">
                                      <span>Speed:</span>
                                      <span>{data.responseTime}ms</span>
                                    </div>
                                  </div>
                                )}
                                {!data.success && data.error && (
                                  <p className="text-red-300 text-xs mt-1">{data.error}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="text-red-300">Test failed</p>
                      )}
                    </div>

                    {/* Sell Test */}
                    <div className={`p-4 rounded-lg border-2 ${
                      searchResult.tradeTest.sellTest.success ? 'bg-green-900 border-green-600' : 'bg-red-900 border-red-600'
                    }`}>
                      <h5 className="font-bold text-lg mb-3 text-white">
                        🔴 SELL Test {searchResult.tradeTest.sellTest.success ? '✅' : '❌'}
                      </h5>
                      
                      {searchResult.tradeTest.sellTest.success && searchResult.tradeTest.sellTest.priceComparison ? (
                        <div className="space-y-3 text-white">
                          {/* Best Price Summary */}
                          <div className="bg-green-800 p-3 rounded">
                            <p className="text-sm text-green-200">🏆 Best Price</p>
                            <p><strong>Provider:</strong> {getProviderIcon(searchResult.tradeTest.sellTest.priceComparison.bestPrice.provider)} {searchResult.tradeTest.sellTest.priceComparison.bestPrice.provider}</p>
                            <p><strong>Amount:</strong> {
                              searchResult.tradeTest.sellTest.priceComparison.bestPrice.outputAmount
                                ? parseFloat(searchResult.tradeTest.sellTest.priceComparison.bestPrice.outputAmount).toFixed(6)
                                : 'N/A'
                            } SOL</p>
                            <p><strong>Advantage:</strong> <span className="text-green-300">{searchResult.tradeTest.sellTest.priceComparison.bestPrice.advantage}</span></p>
                          </div>
                          
                          {/* Price Metrics */}
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="bg-gray-800 p-2 rounded">
                              <p className="text-gray-400">Price Spread</p>
                              <p className="font-bold">{searchResult.tradeTest.sellTest.priceComparison.priceSpread}</p>
                            </div>
                            <div className="bg-gray-800 p-2 rounded">
                              <p className="text-gray-400">Avg Impact</p>
                              <p className="font-bold">{searchResult.tradeTest.sellTest.priceComparison.avgPriceImpact}</p>
                            </div>
                          </div>

                          {/* Provider Details */}
                          <div className="space-y-2">
                            <p className="text-sm font-bold text-green-200">Provider Breakdown:</p>
                            {Object.entries(searchResult.tradeTest.sellTest.priceComparison.providers).map(([provider, data]) => (
                              <div key={provider} className={`p-2 rounded text-xs ${
                                data.success ? 'bg-green-800' : 'bg-red-800'
                              }`}>
                                <div className="flex justify-between items-center">
                                  <span className="font-bold">{getProviderIcon(provider)} {provider}</span>
                                  <span className={data.success ? 'text-green-200' : 'text-red-200'}>
                                    {data.success ? '✅' : '❌'}
                                  </span>
                                </div>
                                {data.success && (
                                  <div className="mt-1 space-y-1">
                                    <div className="flex justify-between">
                                      <span>Amount:</span>
                                      <span>{data.outputAmount ? parseFloat(data.outputAmount).toFixed(9) : 'N/A'} SOL</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span>Impact:</span>
                                      <span>{data.priceImpact}%</span>
                                    </div>
                                    {data.fee && (
                                      <div className="flex justify-between">
                                        <span>Fee:</span>
                                        <span>{typeof data.fee.feePercentage === 'number' ? data.fee.feePercentage.toFixed(3) : 'N/A'}%</span>
                                      </div>
                                    )}
                                    <div className="flex justify-between">
                                      <span>Speed:</span>
                                      <span>{data.responseTime}ms</span>
                                    </div>
                                  </div>
                                )}
                                {!data.success && data.error && (
                                  <p className="text-red-300 text-xs mt-1">{data.error}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="text-red-300">Test failed</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Links */}
              {searchResult.metadata && (searchResult.metadata.website || searchResult.metadata.twitter || searchResult.metadata.telegram) && (
                <div className="mt-6 flex gap-3">
                  {searchResult.metadata.website && (
                    <a 
                      href={searchResult.metadata.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                    >
                      🌐 Website
                    </a>
                  )}
                  {searchResult.metadata.twitter && (
                    <a 
                      href={searchResult.metadata.twitter}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                    >
                      🐦 Twitter
                    </a>
                  )}
                  {searchResult.metadata.telegram && (
                    <a 
                      href={searchResult.metadata.telegram}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                    >
                      💬 Telegram
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Loading Indicator */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          <span className="ml-3 text-white">Loading...</span>
        </div>
      )}
    </div>
  )
}

export default TokenSearchInterface