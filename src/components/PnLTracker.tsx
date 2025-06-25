'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { tradingTracker, TrackingRecord } from '@/utils/trading-tracker'
import { useWallet, useConnection } from './WalletProvider'
import TokenSkeleton from './TokenSkeleton'
import { getSolPriceUSD, SLIPPAGE_OPTIONS, PRIORITY_FEE_OPTIONS } from '@/utils/solana'
import { fetchUserTokens, executeBulkSell, BulkSellRequest, UserToken, TokenToSell } from '@/utils/jupiter'
import { trackSellOperation } from '@/utils/trading-tracker'
import { trackSell } from '@/utils/operations-api'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'

interface PnLRecord {
  id: string
  mintAddress: string
  symbol?: string
  name?: string
  logoURI?: string
  buyTimestamp: number
  sellTimestamp: number
  buyPrice: number // SOL price when bought
  sellPrice: number // SOL price when sold
  solAmountBought: number // SOL spent on buying
  solAmountSold: number // SOL received from selling
  pnlSOL: number // Profit/Loss in SOL
  pnlUSD: number // Profit/Loss in USD
  pnlPercentage: number // Percentage gain/loss
  buySignatures: string[]
  sellSignatures: string[]
}

interface OpenPosition {
  id: string
  mintAddress: string
  symbol?: string
  name?: string
  logoURI?: string
  buyTimestamp: number
  solAmountBought: number // SOL spent on buying
  buySignatures: string[]
  isOpen: boolean // Always true for open positions
  currentUsdValue?: number // Current USD value of the position
  pnlPercentage?: number // Current P&L percentage
  isLoadingPrice?: boolean // Whether we're currently fetching the price
  buyPriceUsd?: number // Buy price in USD
  buyTokenAmount?: number // Amount of the bought token
  currentTokenPriceUsd?: number // Current token price in USD
}

export default function PnLTracker() {
  const { publicKey, connected, signAllTransactions } = useWallet()
  const { connection } = useConnection()
  const [pnlRecords, setPnlRecords] = useState<PnLRecord[]>([])
  const [openPositions, setOpenPositions] = useState<OpenPosition[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [solPriceUsd, setSolPriceUsd] = useState<number>(145)
  const [activeTab, setActiveTab] = useState<'completed' | 'open'>('completed')
  const [isRefreshingPrices, setIsRefreshingPrices] = useState<boolean>(false)
  const [hasInitialPricesFetched, setHasInitialPricesFetched] = useState<boolean>(false)
  
  // Fast sell state
  const [isSelling, setIsSelling] = useState<boolean>(false)
  const [sellError, setSellError] = useState<string>('')
  const [sellingTokenId, setSellingTokenId] = useState<string>('')

  // Clear old localStorage data on component mount
  useEffect(() => {
    console.log('🧹 PnLTracker: Cleared old localStorage data, now using Supabase!')
  }, [])

  // Fetch SOL price
  const fetchSolPrice = React.useCallback(async () => {
    try {
      const price = await getSolPriceUSD()
      setSolPriceUsd(price)
    } catch (error) {
      console.error('Error fetching SOL price:', error)
    }
  }, [])

  // Calculate PnL records by matching buy and sell operations
  const calculatePnL = useCallback(async () => {
    if (!connected || !publicKey) {
      setPnlRecords([])
      setOpenPositions([])
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const walletAddress = publicKey.toString()
      const allRecords = await tradingTracker.getWalletRecords(walletAddress)
      
      // Get successful buy and sell records
      const buyRecords = allRecords.filter(record => 
        record.operationType === 'buy' && record.successCount > 0
      )
      
      // Process sell records with sell+close combination logic similar to TradingHistory
      const allSellRecords = allRecords.filter(record => 
        record.operationType === 'sell' && record.successCount > 0
      )
      
      // Apply the same sell+close combination logic as TradingHistory for consistency
      const processedSellRecords: TrackingRecord[] = []
      const processedRecordIds = new Set<string>()

      allSellRecords.forEach(sellRecord => {
        if (processedRecordIds.has(sellRecord.id)) return

        // Look for a close operation within 30 seconds (same logic as TradingHistory)
        const closeRecord = allRecords.find(r => 
          r.operationType === 'close' && 
          r.successCount > 0 &&
          !processedRecordIds.has(r.id) &&
          Math.abs(r.timestamp - sellRecord.timestamp) <= 30000 // 30 seconds
        )

        if (closeRecord) {
          // Combine sell and close into one record for P&L calculation
          const combinedRecord: TrackingRecord = {
            ...sellRecord,
            // Combine tokens but prioritize sell tokens for P&L calculation
            tokens: [...sellRecord.tokens, ...closeRecord.tokens].filter((token, index, self) => 
              index === self.findIndex(t => t.mintAddress === token.mintAddress)
            ),
            successCount: sellRecord.successCount + closeRecord.successCount,
            totalTokens: sellRecord.totalTokens + closeRecord.totalTokens,
            signatures: [...sellRecord.signatures, ...closeRecord.signatures],
          }
          
          processedSellRecords.push(combinedRecord)
          processedRecordIds.add(sellRecord.id)
          processedRecordIds.add(closeRecord.id)
        } else {
          // No matching close operation, keep sell as is
          processedSellRecords.push(sellRecord)
          processedRecordIds.add(sellRecord.id)
        }
      })

      const pnlData: PnLRecord[] = []
      const openData: OpenPosition[] = []
      const soldTokens = new Set<string>()

      // For each processed sell record, try to find matching buy records
      processedSellRecords.forEach(sellRecord => {
        sellRecord.tokens.forEach(soldToken => {
          soldTokens.add(soldToken.mintAddress)
          
          // Find the most recent buy record for this token before the sell
          const matchingBuy = buyRecords
            .filter(buyRecord => 
              buyRecord.timestamp < sellRecord.timestamp &&
              buyRecord.tokens.some(buyToken => buyToken.mintAddress === soldToken.mintAddress)
            )
            .sort((a, b) => b.timestamp - a.timestamp)[0] // Most recent buy

          if (matchingBuy && matchingBuy.solAmount && sellRecord.solAmount) {
            // Get the corresponding buy token data
            const buyToken = matchingBuy.tokens.find(t => t.mintAddress === soldToken.mintAddress)
            
            // Use actual prices if available, otherwise fall back to SOL amount calculations
            let pnlSOL: number
            let pnlPercentage: number
            let pnlUSD: number
            let buyPriceUsd: number
            let sellPriceUsd: number

            if (buyToken?.priceUsd && soldToken.priceUsd) {
              // Use actual token prices for accurate calculation
              buyPriceUsd = buyToken.priceUsd
              sellPriceUsd = soldToken.priceUsd
              
              // Calculate P&L percentage based on token price change
              pnlPercentage = ((sellPriceUsd - buyPriceUsd) / buyPriceUsd) * 100
              
              // Calculate SOL P&L based on the SOL amounts and success counts
              const solPerTokenBuy = matchingBuy.solAmount / matchingBuy.successCount
              const solPerTokenSell = sellRecord.solAmount / sellRecord.successCount
              pnlSOL = solPerTokenSell - solPerTokenBuy
              
              // Calculate USD P&L
              pnlUSD = pnlSOL * (sellRecord.solPriceUsd || solPriceUsd)
            } else {
              // Fallback to SOL amount calculations
              const solPerTokenBuy = matchingBuy.solAmount / matchingBuy.successCount
              const solPerTokenSell = sellRecord.solAmount / sellRecord.successCount
              
              pnlSOL = solPerTokenSell - solPerTokenBuy
              pnlPercentage = ((solPerTokenSell - solPerTokenBuy) / solPerTokenBuy) * 100
              pnlUSD = pnlSOL * solPriceUsd
              
              buyPriceUsd = matchingBuy.solPriceUsd || solPriceUsd
              sellPriceUsd = sellRecord.solPriceUsd || solPriceUsd
            }

            const pnlRecord: PnLRecord = {
              id: `${matchingBuy.id}-${sellRecord.id}-${soldToken.mintAddress}`,
              mintAddress: soldToken.mintAddress,
              symbol: soldToken.symbol,
              name: soldToken.name,
              logoURI: soldToken.logoURI,
              buyTimestamp: matchingBuy.timestamp,
              sellTimestamp: sellRecord.timestamp,
              buyPrice: buyPriceUsd,
              sellPrice: sellPriceUsd,
              solAmountBought: matchingBuy.solAmount / matchingBuy.successCount,
              solAmountSold: sellRecord.solAmount / sellRecord.successCount,
              pnlSOL,
              pnlUSD,
              pnlPercentage,
              buySignatures: matchingBuy.signatures,
              sellSignatures: sellRecord.signatures
            }

            pnlData.push(pnlRecord)
          }
        })
      })

      // Calculate open positions (bought but not sold tokens)
      buyRecords.forEach(buyRecord => {
        buyRecord.tokens.forEach(buyToken => {
          // Check if this token hasn't been sold yet
          if (!soldTokens.has(buyToken.mintAddress) && buyRecord.solAmount) {
            const solPerToken = buyRecord.solAmount / buyRecord.successCount
            
            const openPosition: OpenPosition = {
              id: `${buyRecord.id}-${buyToken.mintAddress}`,
              mintAddress: buyToken.mintAddress,
              symbol: buyToken.symbol,
              name: buyToken.name,
              logoURI: buyToken.logoURI,
              buyTimestamp: buyRecord.timestamp,
              solAmountBought: solPerToken,
              buySignatures: buyRecord.signatures,
              isOpen: true,
              // Store buy price for later comparison
              buyPriceUsd: buyToken.priceUsd,
              buyTokenAmount: buyToken.tokenAmount
            }

            openData.push(openPosition)
          }
        })
      })

      // Sort by timestamp (most recent first)
      pnlData.sort((a, b) => b.sellTimestamp - a.sellTimestamp)
      openData.sort((a, b) => b.buyTimestamp - a.buyTimestamp)
      
      setPnlRecords(pnlData)
      setOpenPositions(openData)
    } catch (err) {
      console.error('Error calculating PnL:', err)
      setError('Failed to calculate PnL data')
      setPnlRecords([])
      setOpenPositions([])
    } finally {
      setIsLoading(false)
    }
  }, [connected, publicKey, solPriceUsd])

  // Load PnL data when wallet connects or records change
  useEffect(() => {
    if (connected && publicKey) {
    calculatePnL()
    }
  }, [calculatePnL, connected, publicKey])

  // Set up real-time subscription for trading records (debounced to prevent duplicate calls)
  useEffect(() => {
    if (!connected || !publicKey) return

    const walletAddress = publicKey.toString()
    let debounceTimeout: NodeJS.Timeout | null = null
    
    // Subscribe to real-time updates with debouncing
    const unsubscribe = tradingTracker.subscribeToWallet(walletAddress, () => {
      console.log('📡 Real-time PnL update received')
      
      // Clear existing timeout
      if (debounceTimeout) {
        clearTimeout(debounceTimeout)
      }
      
      // Debounce rapid updates (wait 500ms after last update before recalculating)
      debounceTimeout = setTimeout(() => {
        calculatePnL() // Recalculate PnL when new records arrive
      }, 500)
    })

    return () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout)
      }
      unsubscribe()
    }
  }, [connected, publicKey, calculatePnL])

  // Fetch SOL price on mount and periodically (reduced frequency)
  useEffect(() => {
    fetchSolPrice()
    // Reduced frequency: every 5 minutes instead of 1 minute
    const interval = setInterval(fetchSolPrice, 300000)
    return () => clearInterval(interval)
  }, [fetchSolPrice])

  // Function to fetch current prices for open positions
  const refreshOpenPositionPrices = React.useCallback(async () => {
    if (openPositions.length === 0) return

    setIsRefreshingPrices(true)
    
    try {
      // Mark all positions as loading
      setOpenPositions(prev => prev.map(pos => ({ ...pos, isLoadingPrice: true })))

      // Get all mint addresses for open positions
      const mintAddresses = openPositions.map(pos => pos.mintAddress)
      
      // Fetch current prices from Jupiter API
      const priceResponse = await fetch(`https://api.jup.ag/price/v2?ids=${mintAddresses.join(',')}`)
      const priceData = await priceResponse.json()

      // Update positions with current prices and calculate P&L
      setOpenPositions(prev => prev.map(position => {
        const currentPriceData = priceData?.data?.[position.mintAddress]
        
        if (currentPriceData && currentPriceData.price) {
          const currentTokenPriceUsd = parseFloat(currentPriceData.price)
          
          // Use actual buy price if available for accurate P&L calculation
          if (position.buyPriceUsd && position.buyPriceUsd > 0) {
            // Accurate calculation using actual token buy price vs current price
            const pnlPercentage = ((currentTokenPriceUsd - position.buyPriceUsd) / position.buyPriceUsd) * 100
            
            // Estimate current USD value based on initial SOL investment and price change
            const initialUsdValue = position.solAmountBought * solPriceUsd
            const priceMultiplier = currentTokenPriceUsd / position.buyPriceUsd
            const estimatedCurrentValue = initialUsdValue * priceMultiplier

            return {
              ...position,
              currentUsdValue: estimatedCurrentValue,
              currentTokenPriceUsd,
              pnlPercentage,
              isLoadingPrice: false
            }
          } else {
            // Fallback calculation for positions without stored buy price
            const initialUsdValue = position.solAmountBought * solPriceUsd
            const currentSolValue = position.solAmountBought
            const currentUsdValue = currentSolValue * solPriceUsd
            
            // Rough estimation based on price action
            const priceMultiplier = currentTokenPriceUsd / (initialUsdValue / currentSolValue)
            const estimatedCurrentValue = initialUsdValue * Math.max(0.1, priceMultiplier)
            const pnlPercentage = ((estimatedCurrentValue - initialUsdValue) / initialUsdValue) * 100

            return {
              ...position,
              currentUsdValue: estimatedCurrentValue,
              currentTokenPriceUsd,
              pnlPercentage,
              isLoadingPrice: false
            }
          }
        }

        return {
          ...position,
          isLoadingPrice: false
        }
      }))
    } catch (error) {
      console.error('Error refreshing open position prices:', error)
      // Remove loading state on error
      setOpenPositions(prev => prev.map(pos => ({ ...pos, isLoadingPrice: false })))
    } finally {
      setIsRefreshingPrices(false)
    }
  }, [openPositions, solPriceUsd])

  // Fast sell function for open positions
  const handleFastSell = React.useCallback(async (position: OpenPosition, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    if (!connected || !publicKey || !signAllTransactions) {
      setSellError('Please connect your wallet first')
      return
    }

    setIsSelling(true)
    setSellingTokenId(position.id)
    setSellError('')

    try {
      // Fetch current user tokens to get the exact token data
      const userTokens = await fetchUserTokens(connection, publicKey, false, false)
      
      // Find the specific token in user's wallet
      const tokenToSell = userTokens.find(token => token.mintAddress === position.mintAddress)
      
      if (!tokenToSell || tokenToSell.uiAmount <= 0) {
        throw new Error('Token not found in wallet or has zero balance')
      }

      // Convert to TokenToSell format for bulk sell
      const tokenForSale: TokenToSell = {
        ...tokenToSell,
        sellAmount: tokenToSell.balance, // Sell 100% of the token
        sellPercentage: 100
      }

      // Prepare bulk sell request
      const sellRequest: BulkSellRequest = {
        tokens: [tokenForSale],
        slippage: 100, // 1% slippage (default)
        priorityFee: 100000, // 0.0001 SOL priority fee (default)
      }

      // Execute the sell
      const sellResult = await executeBulkSell(
        sellRequest,
        publicKey.toString(),
        connection,
        signAllTransactions
      )

      if (sellResult.success && sellResult.successfulSwaps.length > 0) {
        // Track the successful sell operation
        try {
          const trackResult = await trackSell(
            publicKey.toString(),
            sellResult.successfulSwaps.length,
            {
              failureCount: sellResult.failedSwaps.length,
              solAmount: sellResult.totalReceived || 0,
              tokenMints: [position.mintAddress],
              signatures: sellResult.signatures,
            }
          )
          console.log(`🎉 Earned ${trackResult.pointsEarned} points from fast sell!`)

          // Track locally for TradingHistory
          const { fetchTokenPricesForTracking } = await import('@/utils/trading-tracker')
          const tokenPrices = await fetchTokenPricesForTracking([position.mintAddress])
          const currentSolPrice = await getSolPriceUSD()

          const enhancedTokenData = [{
            mintAddress: position.mintAddress,
            symbol: position.symbol,
            name: position.name,
            logoURI: position.logoURI,
            priceUsd: tokenPrices[position.mintAddress] || 0,
            tokenAmount: tokenToSell.balance
          }]

          trackSellOperation(
            publicKey.toString(),
            enhancedTokenData,
            sellResult.totalReceived || 0,
            1, // successCount
            0, // failureCount
            sellResult.signatures,
            0, // feesPaid
            1, // slippage (1%)
            100000, // priorityFee
            undefined, // errors
            currentSolPrice
          )

          // Refresh the P&L data to reflect the sale
          setTimeout(() => {
            calculatePnL()
            setHasInitialPricesFetched(false) // Reset to refetch prices for remaining positions
          }, 200)

          // Show success message briefly
          setSellError('')
        } catch (trackError) {
          console.error('Failed to track sell operation:', trackError)
        }
      } else {
        throw new Error('Failed to sell token: ' + (sellResult.failedSwaps[0]?.error || 'Unknown error'))
      }
    } catch (err) {
      console.error('Fast sell error:', err)
      setSellError(err instanceof Error ? err.message : 'Failed to sell token')
    } finally {
      setIsSelling(false)
      setSellingTokenId('')
    }
  }, [connected, publicKey, signAllTransactions, connection, calculatePnL])

  // Initial price fetch and automatic refresh every 30 seconds
  useEffect(() => {
    if (openPositions.length > 0 && !hasInitialPricesFetched && !isRefreshingPrices) {
      console.log('📊 Initial price fetch for open positions...')
      refreshOpenPositionPrices()
      setHasInitialPricesFetched(true)
    } else if (openPositions.length === 0) {
      // Reset flag when no open positions
      setHasInitialPricesFetched(false)
    }
  }, [openPositions.length, hasInitialPricesFetched, refreshOpenPositionPrices, isRefreshingPrices])

  // Auto-refresh prices every 30 seconds for open positions
  useEffect(() => {
    if (openPositions.length === 0) return

    console.log('⏰ Setting up 30s auto-refresh for open position prices')
    const interval = setInterval(() => {
      if (!isRefreshingPrices) {
        console.log('🔄 Auto-refreshing open position prices (30s interval)')
        refreshOpenPositionPrices()
      }
    }, 30000) // 30 seconds

    return () => {
      console.log('⏰ Clearing auto-refresh interval')
      clearInterval(interval)
    }
  }, [openPositions.length, refreshOpenPositionPrices, isRefreshingPrices])

  // Listen for new trading records and auto-refresh (debounced to prevent duplicates)
  useEffect(() => {
    let eventDebounceTimeout: NodeJS.Timeout | null = null

    const handleNewRecord = (event: CustomEvent) => {
      console.log('🔄 New trading record detected, refreshing PnL...', event.detail)
      
      // Clear existing timeout to prevent duplicate refreshes
      if (eventDebounceTimeout) {
        clearTimeout(eventDebounceTimeout)
      }
      
      // Debounce the PnL calculation to prevent duplicate calls
      eventDebounceTimeout = setTimeout(() => {
        calculatePnL()
        // Reset price fetch flag so new positions get initial prices
        setHasInitialPricesFetched(false)
      }, 1000) // 1 second debounce for event-based updates
    }

    window.addEventListener('tradingRecordAdded', handleNewRecord as EventListener)
    return () => {
      if (eventDebounceTimeout) {
        clearTimeout(eventDebounceTimeout)
      }
      window.removeEventListener('tradingRecordAdded', handleNewRecord as EventListener)
    }
  }, [calculatePnL])

  const formatRelativeTime = (timestamp: number) => {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / (1000 * 60))
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return `${days}d ago`
  }

  const openTransactionOnSolscan = (signatures: string[]) => {
    if (signatures && signatures.length > 0) {
      const signature = signatures[0]
      const solscanUrl = `https://solscan.io/tx/${signature}`
      window.open(solscanUrl, '_blank', 'noopener,noreferrer')
    }
  }

  const formatPnL = (pnl: number, isPercentage: boolean = false) => {
    const isPositive = pnl > 0
    const color = isPositive ? 'text-green-400' : 'text-red-400'
    const prefix = isPositive ? '+' : ''
    
    if (isPercentage) {
      return (
        <span className={color}>
          {prefix}{pnl.toFixed(2)}%
        </span>
      )
    }
    
    return (
      <span className={color}>
        {prefix}{pnl.toFixed(4)} SOL
      </span>
    )
  }

  // Show error state
  if (error && error.includes('Browser storage')) {
    return (
      <div className="bg-gray-800 border border-gray-600 rounded-xl p-4 text-center">
        <p className="text-gray-400 text-sm">{error}</p>
      </div>
    )
  }

  // Show loading state
  if (isLoading) {
    return (
      <div className="">
        <TokenSkeleton count={3} variant="trading-history" />
      </div>
    )
  }

  return (
    <div className="">
                {/* Error Display */}
      {error && (
        <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-3 mb-3 text-center">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Sell Error Display */}
      {sellError && (
        <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-3 mb-3 text-center">
          <p className="text-red-400 text-sm">Sell Error: {sellError}</p>
        </div>
      )}

      {connected && (
        <>
          {/* Tab Navigation */}
          <div className="flex space-x-1 mb-3 bg-gray-800 rounded-lg p-1">
            <button
              onClick={() => setActiveTab('completed')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                activeTab === 'completed'
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
              }`}
            >
              Closed P&L ({pnlRecords.length})
            </button>
            <button
              onClick={() => setActiveTab('open')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                activeTab === 'open'
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700/50'
              }`}
            >
              Open Positions ({openPositions.length}) 
              {openPositions.length > 0 && <span className="text-green-400 ml-1">⚡</span>}
            </button>
            {activeTab === 'open' && openPositions.length > 0 && (
              <button
                onClick={() => {
                  console.log('🔄 Manual refresh triggered by user')
                  refreshOpenPositionPrices()
                }}
                disabled={isRefreshingPrices}
                className="px-3 py-1.5 text-xs font-medium rounded-md transition-all bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-1"
                title="Manually refresh current prices for open positions"
              >
                <svg 
                  className={`w-3 h-3 ${isRefreshingPrices ? 'animate-spin' : ''}`} 
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24"
                >
                  <path 
                    strokeLinecap="round" 
                    strokeLinejoin="round" 
                    strokeWidth={2} 
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" 
                  />
                </svg>
                <span>{isRefreshingPrices ? 'Updating...' : 'Refresh Prices'}</span>
              </button>
            )}
          </div>

          {/* Content based on active tab */}
          {activeTab === 'completed' ? (
            // Completed PnL Records
            pnlRecords.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-gray-400 text-sm">Buy and sell tokens to track your completed trades</p>
              </div>
            ) : (
              <div className="flex space-x-0 overflow-x-auto mb-3 scrollbar-hide">
                {pnlRecords.slice(0, 10).map((record) => (
                  <div
                    key={record.id}
                    className="flex-shrink-0 p-0 hover:bg-gray-700/40 transition-all duration-200 min-w-[180px] rounded-lg cursor-pointer group p-4"
                    onClick={() => openTransactionOnSolscan(record.sellSignatures)}
                    title="Click to view sell transaction on Solscan"
                  >
                    {/* Line 1: Timestamp */}
                    <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                      <span>{formatRelativeTime(record.sellTimestamp)}</span>
                      <svg 
                        className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity duration-200" 
                        fill="none" 
                        stroke="currentColor" 
                        viewBox="0 0 24 24"
                      >
                        <path 
                          strokeLinecap="round" 
                          strokeLinejoin="round" 
                          strokeWidth={2} 
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" 
                        />
                      </svg>
                    </div>
                    
                    {/* Line 2: Token and PnL */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <div className="w-4 h-4 bg-gray-700 rounded-full flex items-center justify-center overflow-hidden">
                          {record.logoURI ? (
                            <img 
                              src={record.logoURI} 
                              alt={record.symbol || record.name || 'Token'} 
                              className="w-full h-full object-cover" 
                              onError={(e) => {
                                e.currentTarget.onerror = null
                                e.currentTarget.src = ''
                                if (e.currentTarget.parentElement) {
                                  e.currentTarget.parentElement.textContent = (record.symbol || record.name || '?').charAt(0).toUpperCase()
                                }
                              }} 
                            />
                          ) : (
                            <span className="text-white text-xs font-bold">
                              {(record.symbol || record.name || '?').charAt(0).toUpperCase()}
                            </span>
                          )}
                        </div>
                        <span className="text-sm text-white font-medium">
                          {record.symbol || record.name || 'Token'}
                        </span>
                      </div>
                    </div>
                    
                    {/* Line 3: PnL Amount and Percentage */}
                    <div className="flex items-center justify-between mt-1">
                      <div className="text-xs">
                        {formatPnL(record.pnlSOL)}
                      </div>
                      <div className="text-xs">
                        {formatPnL(record.pnlPercentage, true)}
                      </div>
                    </div>
                    
                    {/* Line 4: USD Value */}
                    <div className="text-xs text-gray-400 mt-0.5 flex justify-between items-center">
                      <span>{record.pnlUSD > 0 ? '+' : ''}${Math.abs(record.pnlUSD).toFixed(2)}</span>
                      {record.buyPrice && record.sellPrice && record.buyPrice > 0 && record.sellPrice > 0 && (
                        <span className="text-green-400 text-xs">✓</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            // Open Positions
            openPositions.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-gray-400 text-sm">No open positions. Buy tokens to start tracking.</p>
              </div>
            ) : (
              <>
                <div className="text-center py-2 mb-2">
                  <p className="text-gray-400 text-xs">💡 Click any position to instantly sell it with 1% slippage</p>
                </div>
                <div className="flex space-x-0 overflow-x-auto mb-3 scrollbar-hide">
                {openPositions.slice(0, 10).map((position) => (
                  <div
                    key={position.id}
                    className={`flex-shrink-0 p-0 transition-all duration-200 min-w-[180px] rounded-lg cursor-pointer group p-4 relative ${
                      sellingTokenId === position.id 
                        ? 'bg-red-800/30 border border-red-600' 
                        : 'hover:bg-green-700/40 hover:border-green-600/50 border border-transparent'
                    }`}
                    onClick={(e) => handleFastSell(position, e)}
                    title={sellingTokenId === position.id ? 'Selling...' : 'Click to sell this position'}
                  >
                    {/* Loading spinner overlay for selling state */}
                    {sellingTokenId === position.id && (
                      <div className="absolute inset-0 bg-red-900/50 rounded-lg flex items-center justify-center z-10">
                        <div className="w-6 h-6 border-2 border-red-400 border-t-red-200 rounded-full animate-spin"></div>
                      </div>
                    )}
                    {/* Line 1: Timestamp */}
                    <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                      <span>{formatRelativeTime(position.buyTimestamp)}</span>
                      <div className="flex items-center space-x-1">
                        <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                        {sellingTokenId !== position.id && (
                          <svg 
                            className="w-3 h-3 opacity-0 group-hover:opacity-80 transition-opacity duration-200 text-green-400" 
                            fill="none" 
                            stroke="currentColor" 
                            viewBox="0 0 24 24"
                          >
                            <path 
                              strokeLinecap="round" 
                              strokeLinejoin="round" 
                              strokeWidth={2} 
                              d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2z" 
                            />
                          </svg>
                        )}
                        {sellingTokenId === position.id && (
                          <svg 
                            className="w-3 h-3 text-red-400 animate-pulse" 
                            fill="none" 
                            stroke="currentColor" 
                            viewBox="0 0 24 24"
                          >
                            <path 
                              strokeLinecap="round" 
                              strokeLinejoin="round" 
                              strokeWidth={2} 
                              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" 
                            />
                          </svg>
                        )}
                      </div>
                    </div>
                    
                    {/* Line 2: Token */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <div className="w-4 h-4 bg-gray-700 rounded-full flex items-center justify-center overflow-hidden">
                          {position.logoURI ? (
                            <img 
                              src={position.logoURI} 
                              alt={position.symbol || position.name || 'Token'} 
                              className="w-full h-full object-cover" 
                              onError={(e) => {
                                e.currentTarget.onerror = null
                                e.currentTarget.src = ''
                                if (e.currentTarget.parentElement) {
                                  e.currentTarget.parentElement.textContent = (position.symbol || position.name || '?').charAt(0).toUpperCase()
                                }
                              }} 
                            />
                          ) : (
                            <span className="text-white text-xs font-bold">
                              {(position.symbol || position.name || '?').charAt(0).toUpperCase()}
                            </span>
                          )}
                        </div>
                        <span className="text-sm text-white font-medium">
                          {position.symbol || position.name || 'Token'}
                        </span>
                      </div>
                    </div>
                    
                    {/* Line 3: Position Value and P&L */}
                    <div className="flex items-center justify-between mt-1">
                      <div className="text-xs text-gray-300">
                        {position.solAmountBought.toFixed(4)} SOL
                      </div>
                      <div className="text-xs">
                        {position.isLoadingPrice ? (
                          <div className="flex items-center space-x-1">
                            <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse"></div>
                            <span className="text-gray-400">...</span>
                          </div>
                        ) : position.pnlPercentage !== undefined ? (
                          <span className={`font-medium ${
                            position.pnlPercentage > 0 
                              ? 'text-green-400' 
                              : position.pnlPercentage < 0 
                                ? 'text-red-400' 
                                : 'text-gray-400'
                          }`}>
                            {position.pnlPercentage > 0 ? '+' : ''}{position.pnlPercentage.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-blue-400">OPEN</span>
                        )}
                      </div>
                    </div>
                    
                    {/* Line 4: USD Value */}
                    <div className="text-xs text-gray-400 mt-0.5">
                      {position.currentUsdValue !== undefined ? (
                        <div className="flex justify-between items-center">
                          <div className="flex justify-between flex-1">
                            <span>~${(position.solAmountBought * solPriceUsd).toFixed(2)}</span>
                            <span className={`${
                              position.pnlPercentage && position.pnlPercentage > 0 
                                ? 'text-green-400' 
                                : position.pnlPercentage && position.pnlPercentage < 0 
                                  ? 'text-red-400' 
                                  : 'text-gray-400'
                            }`}>
                              →${position.currentUsdValue.toFixed(2)}
                            </span>
                          </div>
                          {position.buyPriceUsd && position.buyPriceUsd > 0 && (
                            <span className="text-green-400 text-xs ml-1">✓</span>
                          )}
                        </div>
                      ) : (
                        <div className="flex justify-between items-center">
                          <span>~${(position.solAmountBought * solPriceUsd).toFixed(2)}</span>
                          {position.buyPriceUsd && position.buyPriceUsd > 0 && (
                            <span className="text-green-400 text-xs">✓</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                </div>
              </>
            )
          )}
        </>
      )}

      {!connected && (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm">Connect your wallet to track trading performance</p>
        </div>
      )}
    </div>
  )
} 