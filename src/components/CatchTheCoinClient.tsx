'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useWallet, useConnection } from '@/components/WalletProvider'
import { useTradingData } from '@/components/TradingDataProvider'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { formatNumber, formatCurrency } from '@/utils/formatters'
import { 
  getSwapQuote, 
  getSwapTransaction, 
  fetchUserTokens, 
  UserToken,
  createFeeTransferInstructions,
  FeeOperationType 
} from '@/utils/jupiter'
import { TOKENS } from '@/utils/solana'

interface TrendingToken {
  token_address: string
  token_symbol: string
  price: number
  change_1h: number
  change_5m: number
  buy_volume_1h: number
  sell_volume_1h: number
  buy_volume_5m: number
  sell_volume_5m: number
  volume_1h: number
  volume_5m: number
  mcap: number
  logo_url?: string
  organic_score: number
  last_updated?: number
  created_at?: number
}

interface JupiterQuote {
  inputMint: string
  inAmount: string
  outputMint: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: string
  slippageBps: number
  platformFee?: {
    amount: string
    feeBps: number
  }
  priceImpactPct: string
  routePlan: any[]
}

interface OwnedTokenInfo {
  balance: number
  usdValue: number
  pnlPercentage?: number
  buyPrice?: number
  currentPrice?: number
}

export default function CatchTheCoinClient() {
  const { connected, publicKey, signTransaction, signAllTransactions } = useWallet()
  const { connection } = useConnection()
  const { records } = useTradingData()
  const [tokens, setTokens] = useState<TrendingToken[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [highlightedTokens, setHighlightedTokens] = useState<Set<string>>(new Set())
  const [buyingTokens, setBuyingTokens] = useState<Set<string>>(new Set())
  const [sellingTokens, setSellingTokens] = useState<Set<string>>(new Set())
  const [quotes, setQuotes] = useState<Map<string, JupiterQuote>>(new Map())
  const [sellQuotes, setSellQuotes] = useState<Map<string, JupiterQuote>>(new Map())
  const [buyAmount, setBuyAmount] = useState<number>(0.1) // Default 0.1 SOL
  const [ownedTokens, setOwnedTokens] = useState<Map<string, OwnedTokenInfo>>(new Map())
  const [userTokens, setUserTokens] = useState<UserToken[]>([])
  const [newTokens, setNewTokens] = useState<Set<string>>(new Set()) // Track new tokens for animation
  const [loadingQuotes, setLoadingQuotes] = useState<Set<string>>(new Set()) // Track which tokens are loading quotes
  const previousPricesRef = useRef<Map<string, number>>(new Map())
  const previousTokensRef = useRef<Set<string>>(new Set()) // Track previous token addresses
  const quoteTimestamps = useRef<Map<string, number>>(new Map()) // Track quote timestamps for expiration

  // Fetch user's wallet tokens
  const fetchWalletTokens = async () => {
    if (!connected || !publicKey) return

    try {
      const walletTokens = await fetchUserTokens(connection, publicKey, false, false)
      setUserTokens(walletTokens)
      
      // Create owned tokens map with PnL calculation
      const ownedMap = new Map<string, OwnedTokenInfo>()
      
      walletTokens.forEach(token => {
        if (token.uiAmount > 0.001) { // Only include meaningful balances
          // Calculate PnL based on trading records
          const buyRecords = records.filter(record => 
            record.operationType === 'buy' && 
            record.tokens.some(t => t.mintAddress === token.mintAddress)
          )
          
          let totalSolSpent = 0
          let totalTokensBought = 0
          
          buyRecords.forEach(record => {
            const tokenInRecord = record.tokens.find(t => t.mintAddress === token.mintAddress)
            if (tokenInRecord && record.solAmount) {
              const solPerToken = record.solAmount / record.successCount
              totalSolSpent += solPerToken
              totalTokensBought += tokenInRecord.tokenAmount || 0
            }
          })
          
          const avgBuyPrice = totalTokensBought > 0 ? totalSolSpent / totalTokensBought : 0
          const currentPrice = token.usdValue / token.uiAmount
          const pnlPercentage = avgBuyPrice > 0 ? ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0
          
          ownedMap.set(token.mintAddress, {
            balance: token.uiAmount,
            usdValue: token.usdValue,
            pnlPercentage: totalSolSpent > 0 ? pnlPercentage : undefined,
            buyPrice: avgBuyPrice > 0 ? avgBuyPrice : undefined,
            currentPrice: currentPrice
          })
        }
      })
      
      setOwnedTokens(ownedMap)
    } catch (err) {
      console.error('Error fetching wallet tokens:', err)
    }
  }

  // Fetch trending tokens with filtering and sorting
  const fetchTrendingTokens = async () => {
    try {
      const response = await fetch('/api/trending')
      if (!response.ok) throw new Error('Failed to fetch trending tokens')
      
      const data = await response.json()
      console.log('Raw trending tokens:', data.tokens?.length || 0)
      
      if (data.tokens && data.tokens.length > 0) {
        // Filter tokens with market cap <= 300k and sort by market cap (small to large)
        const filteredAndSorted = data.tokens
          .filter((token: TrendingToken) => {
            const mcap = token.mcap || 0
            return mcap > 0 && mcap <= 300000 // Max 300k market cap
          })
          .sort((a: TrendingToken, b: TrendingToken) => {
            return (a.mcap || 0) - (b.mcap || 0) // Sort from smallest to largest
          })

        console.log(`Filtered tokens: ${filteredAndSorted.length} (mcap <= 300k)`)
        console.log('Market cap range:', {
          smallest: filteredAndSorted[0]?.mcap || 0,
          largest: filteredAndSorted[filteredAndSorted.length - 1]?.mcap || 0
        })

        // Detect new tokens for animation - Fix the forEach error
        const currentTokenAddresses = new Set(filteredAndSorted.map((t: TrendingToken) => t.token_address))
        const newTokenAddresses = new Set<string>()
        
        // Fix: Ensure previousTokensRef.current is initialized as a Set
        if (!previousTokensRef.current) {
          previousTokensRef.current = new Set<string>()
        }
        
        // Safe iteration over the Set
        for (const address of currentTokenAddresses) {
          if (!previousTokensRef.current.has(address)) {
            newTokenAddresses.add(address)
          }
        }

        // Update previous tokens reference
        previousTokensRef.current = new Set(currentTokenAddresses)

        // Set new tokens for animation (clear after 3 seconds)
        if (newTokenAddresses.size > 0) {
          console.log(`New tokens detected: ${newTokenAddresses.size}`)
          setNewTokens(newTokenAddresses)
          setTimeout(() => {
            setNewTokens(new Set())
          }, 3000)
        }

        setTokens(filteredAndSorted)
        setError(null)
      } else {
        setTokens([])
      }
    } catch (err) {
      console.error('Error fetching trending tokens:', err)
      setError('Failed to load trending tokens')
    } finally {
      setLoading(false)
    }
  }

  // Fetch single quote on hover with caching
  const fetchSingleBuyQuote = async (token: TrendingToken) => {
    if (buyAmount <= 0) return

    const tokenAddress = token.token_address
    const now = Date.now()
    const lastQuoteTime = quoteTimestamps.current.get(tokenAddress) || 0
    
    // Check if we have a recent quote (within 30 seconds)
    if (now - lastQuoteTime < 30000 && quotes.has(tokenAddress)) {
      return
    }

    // Set loading state
    setLoadingQuotes(prev => new Set(prev).add(tokenAddress))

    try {
      const inputAmount = Math.floor(buyAmount * 1e9) // Convert SOL to lamports
      const quote = await getSwapQuote(
        TOKENS.SOL,
        tokenAddress,
        inputAmount,
        300 // 3% slippage
      )

      if (quote) {
        setQuotes(prev => new Map(prev).set(tokenAddress, quote))
        quoteTimestamps.current.set(tokenAddress, now)
      }
    } catch (err) {
      console.error(`Failed to get buy quote for ${token.token_symbol}:`, err)
    } finally {
      // Remove loading state
      setLoadingQuotes(prev => {
        const newSet = new Set(prev)
        newSet.delete(tokenAddress)
        return newSet
      })
    }
  }

  // Handle token hover to fetch quote
  const handleTokenHover = (token: TrendingToken) => {
    const ownedInfo = ownedTokens.get(token.token_address)
    const isOwned = ownedInfo && ownedInfo.balance > 0.001
    
    // Only fetch quote for tokens we don't own
    if (!isOwned) {
      fetchSingleBuyQuote(token)
    }
  }

  // Fetch Jupiter quotes for buying
  const fetchBuyQuotes = async () => {
    if (!tokens.length || buyAmount <= 0) return

    const inputAmount = Math.floor(buyAmount * 1e9) // Convert SOL to lamports

    try {
      const quotePromises = tokens.map(async (token) => {
        try {
          const quote = await getSwapQuote(
            TOKENS.SOL,
            token.token_address,
            inputAmount,
            300 // 3% slippage
          )
          return quote ? { mint: token.token_address, quote } : null
        } catch (err) {
          console.error(`Failed to get buy quote for ${token.token_symbol}:`, err)
          return null
        }
      })

      const results = await Promise.all(quotePromises)
      const newQuotes = new Map<string, JupiterQuote>()
      
      results.forEach((result) => {
        if (result) {
          newQuotes.set(result.mint, result.quote)
        }
      })
      
      setQuotes(newQuotes)
    } catch (err) {
      console.error('Error fetching buy quotes:', err)
    }
  }

  // Check for price changes and highlight tokens
  const checkPriceChanges = () => {
    const newHighlighted = new Set<string>()
    
    tokens.forEach((token) => {
      const previousPrice = previousPricesRef.current.get(token.token_address)
      if (previousPrice && previousPrice !== token.price) {
        const changePercent = Math.abs((token.price - previousPrice) / previousPrice * 100)
        if (changePercent >= 5) {
          newHighlighted.add(token.token_address)
        }
      }
      previousPricesRef.current.set(token.token_address, token.price)
    })
    
    setHighlightedTokens(newHighlighted)
    
    // Clear highlights after 3 seconds
    if (newHighlighted.size > 0) {
      setTimeout(() => {
        setHighlightedTokens(new Set())
      }, 3000)
    }
  }

  // Fetch Jupiter quotes for selling owned tokens
  const fetchSellQuotes = async () => {
    if (!userTokens.length) return

    try {
      const sellQuotePromises = userTokens
        .filter(token => token.uiAmount > 0.001)
        .map(async (token) => {
          try {
            const sellAmount = Math.floor(token.balance) // Use raw balance for quote
            const quote = await getSwapQuote(
              token.mintAddress,
              TOKENS.SOL,
              sellAmount,
              300 // 3% slippage
            )
            return quote ? { mint: token.mintAddress, quote } : null
          } catch (err) {
            console.error(`Failed to get sell quote for ${token.symbol}:`, err)
            return null
          }
        })

      const results = await Promise.all(sellQuotePromises)
      const newSellQuotes = new Map<string, JupiterQuote>()
      
      results.forEach((result) => {
        if (result) {
          newSellQuotes.set(result.mint, result.quote)
        }
      })
      
      setSellQuotes(newSellQuotes)
    } catch (err) {
      console.error('Error fetching sell quotes:', err)
    }
  }

  // Execute buy transaction using existing Jupiter utilities
  const handleBuyToken = async (token: TrendingToken) => {
    if (!connected || !publicKey || !signTransaction) {
      alert('Please connect your wallet first')
      return
    }

    const quote = quotes.get(token.token_address)
    if (!quote) {
      alert('No quote available for this token')
      return
    }

    setBuyingTokens(prev => new Set(prev).add(token.token_address))

    try {
      // Create fee instructions for buy operation
      const feeInstructions = createFeeTransferInstructions(
        publicKey,
        'BUY' as FeeOperationType,
        1,
        buyAmount
      )

      // Get swap transaction using existing utility
      const swapTransaction = await getSwapTransaction(
        quote,
        publicKey.toString(),
        30000, // Priority fee
        feeInstructions
      )

      if (!swapTransaction) {
        throw new Error('Failed to create swap transaction')
      }

      // Deserialize and sign transaction
      const transaction = VersionedTransaction.deserialize(
        Buffer.from(swapTransaction.swapTransaction, 'base64')
      )
      
      const signedTransaction = await signTransaction(transaction)
      
      // Send transaction
      const signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      })

      // Wait for confirmation
      await connection.confirmTransaction(signature, 'confirmed')
      
      alert(`Successfully bought ${token.token_symbol}! Transaction: ${signature}`)
      
      // Refresh wallet tokens and quotes
      await fetchWalletTokens()
      await fetchSellQuotes()
      
    } catch (err) {
      console.error('Error buying token:', err)
      alert(`Failed to buy ${token.token_symbol}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setBuyingTokens(prev => {
        const newSet = new Set(prev)
        newSet.delete(token.token_address)
        return newSet
      })
    }
  }

  // Execute sell transaction using existing Jupiter utilities
  const handleSellToken = async (token: TrendingToken) => {
    if (!connected || !publicKey || !signAllTransactions) {
      alert('Please connect your wallet first')
      return
    }

    const sellQuote = sellQuotes.get(token.token_address)
    const ownedInfo = ownedTokens.get(token.token_address)
    
    if (!sellQuote || !ownedInfo) {
      alert('No sell quote available for this token')
      return
    }

    setSellingTokens(prev => new Set(prev).add(token.token_address))

    try {
      // Calculate expected SOL received
      const expectedSol = parseInt(sellQuote.outAmount) / 1e9
      
      // Create fee instructions for sell operation
      const feeInstructions = createFeeTransferInstructions(
        publicKey,
        'SELL' as FeeOperationType,
        1,
        expectedSol
      )

      // Get swap transaction using existing utility
      const swapTransaction = await getSwapTransaction(
        sellQuote,
        publicKey.toString(),
        30000, // Priority fee
        feeInstructions
      )

      if (!swapTransaction) {
        throw new Error('Failed to create sell transaction')
      }

      // Deserialize and sign transaction
      const transaction = VersionedTransaction.deserialize(
        Buffer.from(swapTransaction.swapTransaction, 'base64')
      )
      
      const signedTransactions = await signAllTransactions([transaction])
      
      // Send transaction
      const signature = await connection.sendRawTransaction(signedTransactions[0].serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      })

      // Wait for confirmation
      await connection.confirmTransaction(signature, 'confirmed')
      
      alert(`Successfully sold ${token.token_symbol} for ${expectedSol.toFixed(4)} SOL! Transaction: ${signature}`)
      
      // Refresh wallet tokens and quotes
      await fetchWalletTokens()
      await fetchSellQuotes()
      
    } catch (err) {
      console.error('Error selling token:', err)
      alert(`Failed to sell ${token.token_symbol}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setSellingTokens(prev => {
        const newSet = new Set(prev)
        newSet.delete(token.token_address)
        return newSet
      })
    }
  }

  // Format time ago
  const formatTimeAgo = (dateString: string) => {
    const now = new Date()
    const created = new Date(dateString)
    const diffMs = now.getTime() - created.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffHours / 24)
    
    if (diffDays > 0) return `${diffDays}d ago`
    if (diffHours > 0) return `${diffHours}h ago`
    return 'Just now'
  }

  // Effects
  useEffect(() => {
    fetchTrendingTokens()
    const interval = setInterval(fetchTrendingTokens, 5 * 60 * 1000) // Every 5 minutes
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (connected && publicKey) {
      fetchWalletTokens()
    }
  }, [connected, publicKey, records])

  // Remove the auto-quoting useEffect
  useEffect(() => {
    if (tokens.length > 0) {
      checkPriceChanges()
      // Removed: fetchBuyQuotes() - no more auto-quoting
    }
  }, [tokens, buyAmount])

  useEffect(() => {
    if (userTokens.length > 0) {
      fetchSellQuotes()
    }
  }, [userTokens])

  useEffect(() => {
    // Check for price changes every 5 seconds
    const interval = setInterval(() => {
      if (tokens.length > 0) {
        fetchTrendingTokens()
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [tokens])

  if (!connected) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-4">🎯 Catch the Coin</h1>
          <p className="text-gray-400 mb-8">Connect your wallet to start catching trending tokens!</p>
          <div className="bg-gray-800 rounded-lg p-8">
            <p className="text-gray-300">Please connect your wallet to access the Catch the Coin feature.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-white mb-4">🎯 Catch the Coin</h1>
        <p className="text-gray-400 mb-6">One-click buy trending tokens with real-time price alerts & PnL tracking</p>
        
        {/* Buy Amount Selector */}
        <div className="flex items-center justify-center space-x-4 mb-6">
          <label className="text-gray-300">Buy Amount (SOL):</label>
          <select
            value={buyAmount}
            onChange={(e) => setBuyAmount(Number(e.target.value))}
            className="bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
          >
            <option value={0.05}>0.05 SOL</option>
            <option value={0.1}>0.1 SOL</option>
            <option value={0.25}>0.25 SOL</option>
            <option value={0.5}>0.5 SOL</option>
            <option value={1}>1 SOL</option>
            <option value={2}>2 SOL</option>
            <option value={5}>5 SOL</option>
          </select>
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-gray-800 rounded-xl p-6 animate-pulse">
              <div className="flex items-center space-x-3 mb-4">
                <div className="w-12 h-12 bg-gray-700 rounded-full"></div>
                <div className="flex-1">
                  <div className="h-4 bg-gray-700 rounded mb-2"></div>
                  <div className="h-3 bg-gray-700 rounded w-2/3"></div>
                </div>
              </div>
              <div className="space-y-2 mb-4">
                <div className="h-3 bg-gray-700 rounded"></div>
                <div className="h-3 bg-gray-700 rounded w-3/4"></div>
              </div>
              <div className="h-10 bg-gray-700 rounded"></div>
            </div>
          ))}
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-8">
          <div className="bg-red-900/20 border border-red-500 rounded-lg p-6">
            <p className="text-red-400">{error}</p>
            <button
              onClick={fetchTrendingTokens}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Token Cards */}
      {!loading && !error && tokens.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tokens.slice(0, 12).map((token) => {
            const isHighlighted = highlightedTokens.has(token.token_address)
            const isBuying = buyingTokens.has(token.token_address)
            const isSelling = sellingTokens.has(token.token_address)
            const isNewToken = newTokens.has(token.token_address)
            const isLoadingQuote = loadingQuotes.has(token.token_address)
            const quote = quotes.get(token.token_address)
            const sellQuote = sellQuotes.get(token.token_address)
            const ownedInfo = ownedTokens.get(token.token_address)
            const isOwned = ownedInfo && ownedInfo.balance > 0.001
            const expectedTokens = quote ? Number(quote.outAmount) / Math.pow(10, 6) : 0 // Assuming 6 decimals
            const expectedSol = sellQuote ? parseInt(sellQuote.outAmount) / 1e9 : 0

            return (
              <div
                key={token.token_address}
                className={`bg-gray-800 rounded-xl p-6 border transition-all duration-500 hover:scale-105 ${
                  isNewToken
                    ? 'border-cyan-400 shadow-lg shadow-cyan-400/30 animate-bounce-in bg-gradient-to-br from-gray-800 to-cyan-900/20'
                    : isHighlighted
                    ? 'border-yellow-400 shadow-lg shadow-yellow-400/20 animate-pulse'
                    : isOwned
                    ? 'border-green-500 shadow-lg shadow-green-500/20'
                    : 'border-gray-700 hover:border-gray-600'
                }`}
                style={{
                  animationDelay: isNewToken ? `${Math.random() * 0.5}s` : '0s'
                }}
                onMouseEnter={() => handleTokenHover(token)}
              >
                {/* New Token Indicator */}
                {isNewToken && (
                  <div className="flex items-center justify-center mb-3 p-2 bg-cyan-900/30 rounded-lg border border-cyan-400/50 animate-pulse">
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-cyan-400 rounded-full animate-ping"></div>
                      <span className="text-cyan-400 text-sm font-bold">🚀 NEW POTENTIAL</span>
                      <div className="w-2 h-2 bg-cyan-400 rounded-full animate-ping"></div>
                    </div>
                  </div>
                )}

                {/* Owned Token Indicator */}
                {isOwned && (
                  <div className="flex items-center justify-between mb-3 p-2 bg-green-900/20 rounded-lg border border-green-500/30">
                    <div className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                      <span className="text-green-400 text-sm font-medium">OWNED</span>
                    </div>
                    <div className="text-right">
                      <div className="text-green-400 text-sm font-medium">
                        {formatNumber(ownedInfo.balance, 2)} {token.token_symbol}
                      </div>
                      {ownedInfo.pnlPercentage !== undefined && (
                        <div className={`text-xs ${ownedInfo.pnlPercentage >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          PnL: {ownedInfo.pnlPercentage >= 0 ? '+' : ''}{ownedInfo.pnlPercentage.toFixed(2)}%
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Token Header */}
                <div className="flex items-center space-x-3 mb-4">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 ${
                    isNewToken 
                      ? 'bg-gradient-to-r from-cyan-500 to-blue-500 animate-pulse' 
                      : 'bg-gradient-to-r from-purple-500 to-pink-500'
                  }`}>
                    {token.logo_url ? (
                      <img
                        src={token.logo_url}
                        alt={token.token_symbol}
                        className="w-10 h-10 rounded-full"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : (
                      <span className="text-white font-bold text-lg">
                        {token.token_symbol?.charAt(0) || '?'}
                      </span>
                    )}
                  </div>
                  <div className="flex-1">
                    <h3 className="text-white font-semibold text-lg">{token.token_symbol}</h3>
                    <p className="text-gray-400 text-sm truncate">
                      Small Cap • {formatCurrency(token.mcap, 0, true)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-white font-medium">{formatCurrency(token.price, 6, false)}</p>
                    <p className={`text-sm ${token.change_1h >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {token.change_1h >= 0 ? '+' : ''}{Math.abs(token.change_1h) < 1 ? (token.change_1h * 100).toFixed(2) : token.change_1h.toFixed(2)}%
                    </p>
                  </div>
                </div>

                {/* Token Stats */}
                <div className="space-y-2 mb-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Market Cap:</span>
                    <span className={`font-medium ${isNewToken ? 'text-cyan-400' : 'text-white'}`}>
                      {formatCurrency(token.mcap)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Volume 1h:</span>
                    <span className="text-white">{formatCurrency(token.volume_1h)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Volume 5m:</span>
                    <span className="text-white">{formatCurrency(token.volume_5m)}</span>
                  </div>
                  {/* Quote info with loading state */}
                  {!isOwned && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">You'll get:</span>
                      {isLoadingQuote ? (
                        <div className="flex items-center space-x-1">
                          <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                          <span className="text-gray-400 text-xs">Loading...</span>
                        </div>
                      ) : quote ? (
                        <span className="text-green-400">~{formatNumber(expectedTokens, 2, false)} {token.token_symbol}</span>
                      ) : (
                        <span className="text-gray-500 text-xs">Hover to quote</span>
                      )}
                    </div>
                  )}
                  {sellQuote && isOwned && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">Sell for:</span>
                      <span className="text-blue-400">~{expectedSol.toFixed(4)} SOL</span>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="space-y-2">
                  {/* Buy Button */}
                  {!isOwned && (
                    <button
                      onClick={() => handleBuyToken(token)}
                      disabled={isBuying || (!quote && !isLoadingQuote)}
                      className={`w-full py-3 px-4 rounded-lg font-semibold transition-all duration-200 ${
                        isBuying
                          ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                          : quote
                          ? isNewToken
                            ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white hover:from-cyan-700 hover:to-blue-700 hover:scale-105 animate-pulse'
                            : 'bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-700 hover:to-pink-700 hover:scale-105'
                          : isLoadingQuote
                          ? 'bg-gray-700 text-gray-300 cursor-wait'
                          : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                      }`}
                    >
                      {isBuying ? (
                        <div className="flex items-center justify-center space-x-2">
                          <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                          <span>Buying...</span>
                        </div>
                      ) : isLoadingQuote ? (
                        <div className="flex items-center justify-center space-x-2">
                          <div className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin"></div>
                          <span>Getting Quote...</span>
                        </div>
                      ) : quote ? (
                        isNewToken ? (
                          `🚀 Catch NEW ${token.token_symbol} (${buyAmount} SOL)`
                        ) : (
                          `🎯 Catch ${token.token_symbol} (${buyAmount} SOL)`
                        )
                      ) : (
                        'Hover to Quote'
                      )}
                    </button>
                  )}

                  {/* Sell Button */}
                  {isOwned && (
                    <button
                      onClick={() => handleSellToken(token)}
                      disabled={isSelling || !sellQuote}
                      className={`w-full py-3 px-4 rounded-lg font-semibold transition-all duration-200 ${
                        isSelling
                          ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                          : sellQuote
                          ? 'bg-gradient-to-r from-red-600 to-orange-600 text-white hover:from-red-700 hover:to-orange-700 hover:scale-105'
                          : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                      }`}
                    >
                      {isSelling ? (
                        <div className="flex items-center justify-center space-x-2">
                          <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                          <span>Selling...</span>
                        </div>
                      ) : sellQuote ? (
                        `💰 Sell ${token.token_symbol} (${expectedSol.toFixed(4)} SOL)`
                      ) : (
                        'Getting Sell Quote...'
                      )}
                    </button>
                  )}
                </div>

                {/* Highlight Indicator */}
                {isHighlighted && (
                  <div className="mt-2 text-center">
                    <span className="text-yellow-400 text-xs font-medium animate-pulse">
                      🔥 Price moved {`>`}5%!
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && tokens.length === 0 && (
        <div className="text-center py-8">
          <div className="bg-gray-800 rounded-lg p-8">
            <p className="text-gray-300 mb-4">No trending tokens found at the moment.</p>
            <button
              onClick={fetchTrendingTokens}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  )
}