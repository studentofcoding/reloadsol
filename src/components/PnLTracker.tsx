'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { TrackingRecord } from '@/utils/trading-tracker'
import { useWallet, useConnection } from './WalletProvider'
import { useTradingData } from './TradingDataProvider'
import TokenSkeleton from './TokenSkeleton'
import { getSolPriceUSD } from '@/utils/solana'
import { fetchUserTokens, executeBulkSell, BulkSellRequest, UserToken, TokenToSell } from '@/utils/jupiter'
import { SwapQuote } from '@/types'
import { trackSell } from '@/utils/operations-api'
import { usePnLShare } from '@/hooks/usePnLShare'
import PnLShareModal from './PnLShareModal'
import { pnlShareService } from '@/utils/pnl-share-service'
// Using emojis for bot operations to avoid dependencies

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
  solAmountBought: number // SOL spent on buying (proportional for this sell)
  solAmountSold: number // SOL received from selling
  pnlSOL: number // Profit/Loss in SOL
  pnlUSD: number // Profit/Loss in USD
  pnlPercentage: number // Percentage gain/loss
  buySignatures: string[]
  sellSignatures: string[]
  isPartialSell: boolean // New field to indicate if this was a partial sell
  sellTransactionId: string // Unique ID for the sell transaction
  // New fields from API improvements
  status?: 'waiting' | 'tracking' | 'won' | 'lost' | 'skipped'
  tradeComparisonData?: any // Trade comparison result
  tradingSimulation?: any // Trading simulation data
  priceHistory?: Array<{ timestamp: string; price_usd: number; volume?: number }>
  // ✅ NEW: Bot operation fields
  isBotOperation?: boolean // Whether this was a bot operation
  botStrategy?: string // Bot strategy used
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
  actualWalletBalance?: number // Actual balance in wallet
  walletTokenData?: UserToken // Full wallet token data for selling
  // New fields from API improvements
  status?: 'waiting' | 'tracking' | 'won' | 'lost' | 'skipped'
  waitingStartedAt?: string | null
  waitingInitialPrice?: number | null
  tradeComparisonData?: any // Trade comparison result
  tradingSimulation?: any // Trading simulation data
  priceHistory?: Array<{ timestamp: string; price_usd: number; volume?: number }>
  // ✅ NEW: Bot operation fields
  isBotOperation?: boolean // Whether this was a bot operation
  botStrategy?: string // Bot strategy used
}

export default function PnLTracker() {
  const { publicKey, connected, signAllTransactions } = useWallet()
  const { connection } = useConnection()
  const { records, trackOperation, isLoadingRecords } = useTradingData()
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

  // Token chart state
  const [selectedToken, setSelectedToken] = useState<string>('')
  const [isChartLoading, setIsChartLoading] = useState<boolean>(false)

  // ✅ NEW: Use the modular PnL sharing system
  const { 
    shareData, 
    isShareModalOpen, 
    isGeneratingShare, 
    showShareModal, 
    hideShareModal, 
    autoTriggerShare 
  } = usePnLShare()

  // Hint message state
  const [showClosedPositionsHint, setShowClosedPositionsHint] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const dismissed = localStorage.getItem('closedPositionsHintDismissed')
      return dismissed !== 'true'
    }
    return true
  })

  // Sell quote state
  const [sellQuotes, setSellQuotes] = useState<Map<string, SwapQuote>>(new Map())
  const [quotingTokenId, setQuotingTokenId] = useState<string>('')
  const [quoteTimeouts, setQuoteTimeouts] = useState<Map<string, NodeJS.Timeout>>(new Map())

  // ✅ NEW: Bot operation sync state
  const [lastBotSync, setLastBotSync] = useState<number>(0)
  const [isBotSyncActive, setIsBotSyncActive] = useState<boolean>(false)

  // Handler to dismiss the hint message
  const handleDismissHint = useCallback(() => {
    setShowClosedPositionsHint(false)
    localStorage.setItem('pnl-closed-positions-hint-dismissed', 'true')
  }, [])

  // Add this useEffect after other useEffect hooks to persist dismissal state
  useEffect(() => {
    const hintDismissed = localStorage.getItem('pnl-closed-positions-hint-dismissed')
    if (hintDismissed === 'true') {
      setShowClosedPositionsHint(false)
    }
  }, [])

  // ✅ NEW: Bot operation indicator component
  const BotOperationIndicator = ({ isBotOperation, botStrategy }: { 
    isBotOperation?: boolean, 
    botStrategy?: string 
  }) => {
    if (!isBotOperation) return null
    
    return (
      <div className="flex items-center gap-1 text-xs">
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
          🤖 Bot
        </span>
        {botStrategy && (
          <span className="text-gray-500 dark:text-gray-400">
            {botStrategy}
          </span>
        )}
      </div>
    )
  }

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
      const allRecords = records // Use records from React Query
      
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
            // ✅ NEW: Preserve bot operation flags when combining records
            is_bot_operation: sellRecord.is_bot_operation || closeRecord.is_bot_operation,
            bot_strategy: sellRecord.bot_strategy || closeRecord.bot_strategy,
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

      // NEW CYCLE-AWARE PnL CALCULATION ----------------------------------------------------
      // The legacy aggregation logic below mixes multiple buy/sell cycles of the same token
      // into a single position.  That causes a reopened position (buying again after a full
      // close) to inherit the previous PnL.  We now compute PnL on a per-cycle basis: once the
      // remaining token amount for a cycle reaches ~0 the cycle is considered closed and we
      // start a fresh one for any subsequent buys.
      {
        // Helper type for an open trade cycle
        type Cycle = {
          mintAddress: string
          symbol?: string
          name?: string
          logoURI?: string
          totalSolBought: number
          totalSolSold: number
          totalTokenBought: number
          remainingTokenAmount: number
          weightedBuyPriceUsd: number // simple average for now
          weightedSellPriceUsd: number
          buyCount: number
          sellCount: number
          buySignatures: string[]
          sellSignatures: string[]
          firstBuyTimestamp: number
          // ✅ NEW: Track bot operation info
          isBotOperation: boolean
          botStrategy?: string
        }

        const allOpsUnsorted = [...buyRecords, ...processedSellRecords]
        allOpsUnsorted.sort((a, b) => a.timestamp - b.timestamp)

        const openCycles = new Map<string, Cycle>()
        const closedCycles: PnLRecord[] = []

        const solPriceCache = solPriceUsd // capture once

        // Iterate chronologically through all operations and build cycles
        for (const op of allOpsUnsorted) {
          const isBuy = op.operationType === 'buy'
          const tokensInOp = op.tokens || []

          // Guard – skip malformed records
          if (!op.solAmount || op.successCount === 0) continue

          // Evenly distribute SOL across tokens in the operation (we usually have 1 token)
          const solPerToken = op.solAmount / op.successCount

          for (const tkn of tokensInOp) {
            const mint = tkn.mintAddress
            if (!mint) continue

            if (isBuy) {
              let cycle = openCycles.get(mint)
              if (!cycle) {
                cycle = {
                  mintAddress: mint,
                  symbol: tkn.symbol,
                  name: tkn.name,
                  logoURI: tkn.logoURI,
                  totalSolBought: 0,
                  totalSolSold: 0,
                  totalTokenBought: 0,
                  remainingTokenAmount: 0,
                  weightedBuyPriceUsd: 0,
                  weightedSellPriceUsd: 0,
                  buyCount: 0,
                  sellCount: 0,
                  buySignatures: [],
                  sellSignatures: [],
                  firstBuyTimestamp: op.timestamp,
                  // ✅ NEW: Initialize bot operation tracking
                  isBotOperation: !!op.is_bot_operation,
                  botStrategy: op.bot_strategy,
                }
                openCycles.set(mint, cycle)
              }

              const tokenAmt = tkn.tokenAmount || 0
              cycle.totalSolBought += solPerToken
              cycle.totalTokenBought += tokenAmt
              cycle.remainingTokenAmount += tokenAmt
              if (tkn.priceUsd) {
                // simple running average
                cycle.weightedBuyPriceUsd =
                  (cycle.weightedBuyPriceUsd * cycle.buyCount + tkn.priceUsd) / (cycle.buyCount + 1)
              }
              cycle.buyCount += 1
              cycle.buySignatures.push(...op.signatures)
              
              // ✅ NEW: Update bot operation info if this is a bot operation
              if (op.is_bot_operation) {
                cycle.isBotOperation = true
                cycle.botStrategy = op.bot_strategy || cycle.botStrategy
              }
            } else {
              // SELL branch
              const cycle = openCycles.get(mint)
              if (!cycle) {
                // sell without open cycle (shouldn't happen) – skip
                continue
              }

              const tokenAmt = tkn.tokenAmount || 0
              cycle.totalSolSold += solPerToken
              cycle.remainingTokenAmount = Math.max(0, cycle.remainingTokenAmount - tokenAmt)
              if (tkn.priceUsd) {
                cycle.weightedSellPriceUsd =
                  (cycle.weightedSellPriceUsd * cycle.sellCount + tkn.priceUsd) / (cycle.sellCount + 1)
              }
              cycle.sellCount += 1
              cycle.sellSignatures.push(...op.signatures)

              // ✅ NEW: Update bot operation info if this is a bot operation
              if (op.is_bot_operation) {
                cycle.isBotOperation = true
                cycle.botStrategy = op.bot_strategy || cycle.botStrategy
              }

              // If the cycle is fully closed, compute PnL record and remove from open map
              if (cycle.remainingTokenAmount <= 1e-6) {
                const pnlSOL = cycle.totalSolSold - cycle.totalSolBought
                const pnlUSD = pnlSOL * solPriceCache
                const pnlPerc = cycle.totalSolBought > 0 ? (pnlSOL / cycle.totalSolBought) * 100 : 0

                const pnlRecord: PnLRecord = {
                  id: `${mint}-${cycle.firstBuyTimestamp}-${op.timestamp}`,
                  mintAddress: mint,
                  symbol: cycle.symbol,
                  name: cycle.name,
                  logoURI: cycle.logoURI,
                  buyTimestamp: cycle.firstBuyTimestamp,
                  sellTimestamp: op.timestamp,
                  buyPrice: cycle.weightedBuyPriceUsd,
                  sellPrice: cycle.weightedSellPriceUsd,
                  solAmountBought: cycle.totalSolBought,
                  solAmountSold: cycle.totalSolSold,
                  pnlSOL,
                  pnlUSD,
                  pnlPercentage: pnlPerc,
                  buySignatures: cycle.buySignatures,
                  sellSignatures: cycle.sellSignatures,
                  isPartialSell: false,
                  sellTransactionId: `${mint}-${op.timestamp}`,
                  // ✅ NEW: Include bot operation info in PnL records
                  isBotOperation: cycle.isBotOperation,
                  botStrategy: cycle.botStrategy,
                }

                closedCycles.push(pnlRecord)

                openCycles.delete(mint)
              }
            }
          }
        }

        // Build open positions array by checking wallet holdings
        let openPositionsResult: OpenPosition[] = []
        if (openCycles.size > 0) {
          try {
            const walletTokens = await fetchUserTokens(connection, publicKey!, false, false)
            openCycles.forEach((cycle) => {
              const walletTok = walletTokens.find((wt) => wt.mintAddress === cycle.mintAddress)
              if (walletTok && walletTok.uiAmount > 0.001) {
                openPositionsResult.push({
                  id: `open-${cycle.mintAddress}`,
                  mintAddress: cycle.mintAddress,
                  symbol: cycle.symbol || walletTok.symbol,
                  name: cycle.name || walletTok.name,
                  logoURI: cycle.logoURI || walletTok.logoURI,
                  buyTimestamp: cycle.firstBuyTimestamp,
                  solAmountBought: cycle.totalSolBought,
                  buySignatures: cycle.buySignatures,
                  isOpen: true,
                  buyPriceUsd: cycle.weightedBuyPriceUsd,
                  buyTokenAmount: cycle.totalTokenBought,
                  actualWalletBalance: walletTok.uiAmount,
                  walletTokenData: walletTok,
                  // ✅ NEW: Include bot operation info in open positions
                  isBotOperation: cycle.isBotOperation,
                  botStrategy: cycle.botStrategy,
                })
              }
            })
          } catch (walletErr) {
            console.error('Failed fetching wallet tokens for open cycle verification', walletErr)
          }
        }

        // Sort results (newest first)
        closedCycles.sort((a, b) => b.sellTimestamp - a.sellTimestamp)
        openPositionsResult.sort((a, b) => b.buyTimestamp - a.buyTimestamp)

        // Update state and exit this calculation early – legacy logic below is skipped
        setPnlRecords(closedCycles)
        setOpenPositions(openPositionsResult)
        setIsLoading(false)
        return // <––    EARLY EXIT  (legacy aggregation will be skipped)
      }
    } catch (err) {
      console.error('Error calculating PnL:', err)
      setError('Failed to calculate PnL data')
      setPnlRecords([])
      setOpenPositions([])
    } finally {
      setIsLoading(false)
    }
  }, [connected, publicKey, records, solPriceUsd])

  // ✅ NEW: Bot operation sync polling
  useEffect(() => {
    if (!connected || !publicKey) return

    const walletAddress = publicKey.toString()
    let syncInterval: NodeJS.Timeout

    const checkForBotUpdates = async () => {
      try {
        const response = await fetch(`/api/trading/sync?wallet=${encodeURIComponent(walletAddress)}`)
        if (response.ok) {
          const { hasUpdate, lastUpdate, source } = await response.json()
          
          if (hasUpdate && lastUpdate > lastBotSync) {
            console.log(`🤖 Bot operation detected from ${source}, refreshing PnL...`)
            setLastBotSync(lastUpdate)
            setIsBotSyncActive(true)
            
            // Force refresh the PnL calculation
            await calculatePnL()
            
            // Reset sync indicator after a delay
            setTimeout(() => setIsBotSyncActive(false), 2000)
          }
        }
      } catch (error) {
        // Silent fail - sync is best effort
      }
    }

    // Check immediately and then every 10 seconds
    checkForBotUpdates()
    syncInterval = setInterval(checkForBotUpdates, 10000)

    return () => {
      if (syncInterval) clearInterval(syncInterval)
    }
  }, [connected, publicKey, lastBotSync, calculatePnL])

  // Load PnL data when wallet connects or records change
  useEffect(() => {
    if (connected && publicKey && records.length >= 0) { // Allow for empty records array
      calculatePnL()
    }
  }, [calculatePnL, connected, publicKey, records])

  // Real-time updates are now handled by React Query in TradingDataProvider
  // No need for manual subscription here

  // Fetch SOL price on mount and periodically (reduced frequency)
  useEffect(() => {
    fetchSolPrice()
    // Reduced frequency: every 5 minutes instead of 1 minute
    const interval = setInterval(fetchSolPrice, 300000)
    return () => clearInterval(interval)
  }, [fetchSolPrice])

  // Function to refresh wallet balances for open positions
  const refreshWalletBalances = React.useCallback(async () => {
    if (openPositions.length === 0) return

    try {
      const walletTokens = await fetchUserTokens(connection, publicKey!, false, false)
      
      setOpenPositions(prev => prev.map(position => {
        const walletToken = walletTokens.find(token => token.mintAddress === position.mintAddress)
        
        if (walletToken && walletToken.uiAmount > 0) {
          return {
            ...position,
            actualWalletBalance: walletToken.uiAmount,
            walletTokenData: walletToken
          }
        } else {
          // Token no longer in wallet, should be filtered out on next PnL calculation
          console.log(`⚠️ Token ${position.symbol} no longer in wallet`)
          return position
        }
      }))
    } catch (error) {
      console.error('Error refreshing wallet balances:', error)
    }
  }, [openPositions, connection, publicKey])

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
      // Use the new Jupiter API utility
      const { getTokenPrices } = await import('@/utils/jupiter-api')
      const prices = await getTokenPrices(mintAddresses)

      // Update positions with current prices and calculate P&L
      setOpenPositions(prev => prev.map(position => {
        const currentTokenPriceUsd = prices[position.mintAddress]
        
        if (currentTokenPriceUsd && currentTokenPriceUsd > 0) {
          
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

  // Handle token selection for chart display
  const handleSelectToken = useCallback((mintAddress: string) => {
    setSelectedToken(mintAddress)
    setIsChartLoading(true)
  }, [])

  // ✅ NEW: Manual share trigger function (for existing share buttons)
  const handleShare = useCallback(async (coinName: string, profitPercentage: number, tokenAddress?: string) => {
    await showShareModal({
      coinName,
      profitPercentage,
      tokenAddress
    })
  }, [showShareModal])

  // Function to fetch sell quote for a position
  const fetchSellQuote = useCallback(async (position: OpenPosition) => {
    if (!connected || !publicKey || !position.walletTokenData) return

    setQuotingTokenId(position.id)
    
    try {
      const { getSwapQuote } = await import('@/utils/jupiter')
      const quote = await getSwapQuote(
        position.mintAddress,
        'So11111111111111111111111111111111111111112', // SOL mint address
        position.walletTokenData.balance, // Use full balance for quote
        300 // 3% slippage
      )

      if (quote) {
        setSellQuotes(prev => new Map(prev).set(position.id, quote))
      }
    } catch (error) {
      console.error('Failed to fetch sell quote:', error)
    } finally {
      setQuotingTokenId('')
    }
  }, [connected, publicKey])

  // Add these handlers after the fetchSellQuote function
  const handlePositionHover = useCallback((position: OpenPosition) => {
    // Clear any existing timeout for this position
    const existingTimeout = quoteTimeouts.get(position.id)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }

    // Set a new timeout to fetch quote after 300ms hover
    const timeout = setTimeout(() => {
      fetchSellQuote(position)
    }, 300)

    setQuoteTimeouts(prev => new Map(prev).set(position.id, timeout))
  }, [fetchSellQuote, quoteTimeouts])

  const handlePositionHoverOut = useCallback((position: OpenPosition) => {
    // Clear timeout if user stops hovering before quote is fetched
    const existingTimeout = quoteTimeouts.get(position.id)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
      setQuoteTimeouts(prev => {
        const newMap = new Map(prev)
        newMap.delete(position.id)
        return newMap
      })
    }

    // Remove quote after 1 second delay to allow for quick re-hover
    setTimeout(() => {
      setSellQuotes(prev => {
        const newMap = new Map(prev)
        newMap.delete(position.id)
        return newMap
      })
    }, 1000)
  }, [quoteTimeouts])

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
      // Use the pre-verified wallet token data from the position
      let tokenToSell = position.walletTokenData
      
      if (!tokenToSell) {
        // Fallback: fetch current user tokens if wallet data is not available
        console.log('⚠️ No wallet token data in position, fetching fresh...')
        const userTokens = await fetchUserTokens(connection, publicKey, false, false)
        tokenToSell = userTokens.find(token => token.mintAddress === position.mintAddress)
      }
      
      if (!tokenToSell || tokenToSell.uiAmount <= 0) {
        throw new Error(`Token not found in wallet or has zero balance. Expected: ${position.actualWalletBalance?.toFixed(4) || 'unknown'} tokens`)
      }

      console.log(`💰 Selling ${tokenToSell.symbol}: ${tokenToSell.uiAmount} tokens (balance verified: ${position.actualWalletBalance?.toFixed(4) || 'unknown'})`)
      
      // Check if we have a cached quote for faster execution
      const cachedQuote = sellQuotes.get(position.id)
      if (cachedQuote) {
        console.log('🚀 Using cached quote for faster execution')
        // Use cached quote logic here - you can implement direct transaction execution
        // For now, we'll continue with the existing bulk sell approach
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
        slippage: 300, // 3% slippage (default)
        priorityFee: 30000, // 0.0003 SOL priority fee (default),
      }

      // Execute the sell
      const sellResult = await executeBulkSell(
        sellRequest,
        publicKey.toString(),
        connection,
        signAllTransactions
      )

      if (sellResult.success && sellResult.successfulSwaps.length > 0) {
        // Track the successful sell operation for points
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
        } catch (trackError) {
          console.error('Failed to track sell operation for points:', trackError)
        }

        // ✅ NEW: Auto-trigger share modal for fast sells
        const pnlPercentage = pnlShareService.calculatePnLPercentage(
          position.solAmountBought, 
          sellResult.totalReceived || 0
        )
        
        if (Math.abs(pnlPercentage) >= 1) { // Only trigger for trades with >= 1% P&L
          setTimeout(async () => {
            try {
              await autoTriggerShare({
                coinName: position.symbol || position.name || 'Token',
                profitPercentage: pnlPercentage,
                tokenAddress: position.mintAddress,
                solAmountBought: position.solAmountBought,
                solAmountSold: sellResult.totalReceived || 0
              })
            } catch (error) {
              console.error('Error auto-triggering share for fast sell:', error)
            }
          }, 1000)
        }

        // Track operation for PnL and history via React Query system
        // Note: This will automatically trigger PnL recalculation via real-time subscription
        try {
          const { fetchTokenPricesForTracking } = await import('@/utils/trading-tracker')
          const tokenPrices = await fetchTokenPricesForTracking([position.mintAddress])
          const currentSolPrice = await getSolPriceUSD()

          const enhancedTokenData = {
            mintAddress: position.mintAddress,
            symbol: position.symbol,
            name: position.name,
            logoURI: position.logoURI,
            priceUsd: tokenPrices[position.mintAddress] || 0,
            tokenAmount: tokenToSell.balance,
            solPrice: currentSolPrice
          }

          // Track via centralized system - this will trigger automatic PnL refresh
          await trackOperation({
            walletAddress: publicKey.toString(),
            operationType: 'sell',
            tokens: [enhancedTokenData],
            successCount: 1,
            failureCount: 0,
            totalTokens: 1,
            solAmount: sellResult.totalReceived || 0,
            feesPaid: 0,
            solPriceUsd: currentSolPrice,
            totalUsdValue: currentSolPrice ? (sellResult.totalReceived || 0) * currentSolPrice : undefined,
            signatures: sellResult.signatures,
            slippage: 2, // 2% slippage
            priorityFee: 300000,
            errors: undefined
          })

          // Show success message briefly
          setSellError('')
          
          // The PnL will refresh automatically via React Query subscription
          // No need for manual calculatePnL() call
        } catch (trackError) {
          console.error('Failed to track sell operation for history/PnL:', trackError)
          
          // Fallback: manual refresh if tracking fails
          setTimeout(() => {
            calculatePnL()
            setHasInitialPricesFetched(false)
          }, 200)
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

  // Cleanup timeouts when component unmounts
  useEffect(() => {
    return () => {
      quoteTimeouts.forEach(timeout => clearTimeout(timeout))
    }
  }, [quoteTimeouts])

  // Event-based updates are no longer needed - React Query handles all updates
  // The records dependency in the calculatePnL useEffect will trigger recalculation

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
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          {isBotSyncActive && (
            <div className="flex items-center space-x-2 text-purple-400">
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse"></div>
              <span className="text-sm">Bot sync active</span>
            </div>
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex space-x-1 bg-gray-800 rounded-lg p-1">
        <button
          onClick={() => setActiveTab('completed')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'completed'
              ? 'bg-blue-600 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-700'
          }`}
        >
          Past ({pnlRecords.length})
        </button>
        <button
          onClick={() => setActiveTab('open')}
          className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'open'
              ? 'bg-blue-600 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-700'
          }`}
        >
          Open ({openPositions.length})
        </button>
        {connected && (
          <div className="flex items-center space-x-2">
            {activeTab === 'open' && (
              <button
                onClick={refreshOpenPositionPrices}
                disabled={isRefreshingPrices}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white text-sm rounded-lg flex items-center space-x-1 transition-colors"
              >
                <svg className={`w-4 h-4 ${isRefreshingPrices ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <TokenSkeleton key={i} />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-8">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      ) : (
        <>
          {activeTab === 'completed' && (
            <>
              {showClosedPositionsHint && pnlRecords.length === 0 && (
                <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4 mb-4">
                  <div className="flex items-start space-x-3">
                    <div className="flex-shrink-0">
                      <svg className="w-5 h-5 text-blue-400 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <h3 className="text-sm font-medium text-blue-400 mb-1">
                        How P&L Tracking Works
                      </h3>
                      <p className="text-sm text-blue-300 mb-3">
                        Your completed trades will appear here once you buy and sell tokens. The tracker automatically matches your buy and sell operations to calculate profit/loss.
                      </p>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={handleDismissHint}
                          className="text-xs text-blue-400 hover:text-blue-300 underline"
                        >
                          Got it, don't show again
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {pnlRecords.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-400 text-sm">No completed trades yet</p>
                  <p className="text-gray-500 text-xs mt-1">Buy and sell tokens to see your P&L here</p>
                </div>
              ) : (
                <div className="flex space-x-2 overflow-x-auto mb-3 scrollbar-hide">
                  {pnlRecords.map((record) => (
                    <div
                      key={record.id}
                      className={`flex-shrink-0 hover:bg-gray-700/40 transition-all duration-200 w-auto rounded-lg cursor-pointer group py-2 px-3 border ${
                        record.isBotOperation 
                          ? 'border-purple-500/30 bg-purple-900/10' 
                          : 'border-gray-600/30'
                      }`}
                      onClick={() => openTransactionOnSolscan(record.sellSignatures)}
                      title="Click to view transaction on Solscan"
                    >
                      {/* Header: P&L and Share Button */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center space-x-1">
                          <span className={`text-sm font-medium ${
                            record.pnlPercentage > 0 
                              ? 'text-green-400' 
                              : record.pnlPercentage < 0 
                                ? 'text-red-400' 
                                : 'text-gray-400'
                          }`}>
                            {record.pnlPercentage > 0 ? '+' : ''}{record.pnlPercentage.toFixed(1)}%
                          </span>
                          <BotOperationIndicator 
                            isBotOperation={record.isBotOperation} 
                            botStrategy={record.botStrategy} 
                          />
                        </div>
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleShare(
                              record.symbol || record.name || 'Token',
                              record.pnlPercentage,
                              record.mintAddress
                            )
                          }}
                          className="px-1.5 py-0.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          📤
                        </button>
                      </div>

                      {/* Token display */}
                      <div className="flex items-center space-x-2 mb-2">
                        <div className="relative flex items-center">
                          <div className="w-4 h-4 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden border border-gray-600">
                            {record.logoURI ? (
                              <img
                                src={record.logoURI}
                                alt={record.symbol || record.name || 'Token'}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  e.currentTarget.onerror = null
                                  e.currentTarget.src = ''
                                  const parent = e.currentTarget.parentElement as HTMLElement | null
                                  if (parent) {
                                    parent.textContent = (record.symbol || record.name || '?').charAt(0).toUpperCase()
                                  }
                                }}
                              />
                            ) : ((record.symbol || record.name || '?').charAt(0).toUpperCase())}
                          </div>
                        </div>
                        
                        <div className="flex items-center space-x-1 flex-1 min-w-0">
                          <span className="text-xs text-gray-300 font-medium truncate">
                            {record.symbol || record.name || 'Unknown'}
                          </span>
                        </div>
                      </div>

                      {/* SOL amounts */}
                      <div className="text-xs text-gray-300 mb-1">
                        {record.solAmountBought.toFixed(3)} → {record.solAmountSold.toFixed(3)} SOL
                      </div>

                      {/* Footer: Status and timestamp */}
                      <div className="flex items-center justify-between text-xs text-gray-400">
                        <span>{formatRelativeTime(record.sellTimestamp)}</span>
                        <div className="flex items-center space-x-1">
                          {record.status && (
                            <span className={`text-xs px-1 py-0.5 rounded ${
                              record.status === 'won' ? 'bg-green-900/50 text-green-300' :
                              record.status === 'lost' ? 'bg-red-900/50 text-red-300' :
                              'bg-gray-900/50 text-gray-300'
                            }`}>
                              {record.status.toUpperCase()}
                            </span>
                          )}
                          {record.tradeComparisonData && (
                            <span className="text-cyan-400" title="Trade Comparison Available">📊</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {activeTab === 'open' && (
            <>
              {openPositions.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-400 text-sm">No open positions</p>
                  <p className="text-gray-500 text-xs mt-1">Buy some tokens to see your positions here</p>
                </div>
              ) : (
                <div className="flex space-x-2 overflow-x-auto mb-3 scrollbar-hide">
                  {openPositions.map((position) => (
                    <div
                      key={position.id}
                      className={`flex-shrink-0 hover:bg-gray-700/40 transition-all duration-200 min-w-[100px] rounded-lg cursor-pointer group py-2 px-3 border ${
                        position.isBotOperation 
                          ? 'border-purple-500/30 bg-purple-900/10' 
                          : 'border-gray-600/30'
                      }`}
                      title="Open position"
                    >
                      {/* Header: P&L and Fast Sell Button */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center space-x-1">
                          {position.isLoadingPrice ? (
                            <div className="flex items-center space-x-1">
                              <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse"></div>
                              <span className="text-xs text-gray-400">...</span>
                            </div>
                          ) : position.pnlPercentage !== undefined ? (
                            <span className={`text-sm font-medium ${
                              position.pnlPercentage > 0 
                                ? 'text-green-400' 
                                : position.pnlPercentage < 0 
                                  ? 'text-red-400' 
                                  : 'text-gray-400'
                            }`}>
                              {position.pnlPercentage > 0 ? '+' : ''}{position.pnlPercentage.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-blue-400 text-xs">OPEN</span>
                          )}
                          <BotOperationIndicator 
                            isBotOperation={position.isBotOperation} 
                            botStrategy={position.botStrategy} 
                          />
                        </div>
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleFastSell(position, e)
                          }}
                          disabled={isSelling && sellingTokenId === position.id}
                          className="px-1.5 py-0.5 bg-red-600 hover:bg-red-700 disabled:bg-red-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          {isSelling && sellingTokenId === position.id ? (
                            <div className="w-2 h-2 border border-white border-t-transparent rounded-full animate-spin"></div>
                          ) : (
                            '🔴'
                          )}
                        </button>
                      </div>

                      {/* Token display */}
                      <div className="flex items-center space-x-2 mb-2">
                        <div className="relative flex items-center">
                          <div className="w-4 h-4 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden border border-gray-600">
                            {position.logoURI ? (
                              <img
                                src={position.logoURI}
                                alt={position.symbol || position.name || 'Token'}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  e.currentTarget.onerror = null
                                  e.currentTarget.src = ''
                                  const parent = e.currentTarget.parentElement as HTMLElement | null
                                  if (parent) {
                                    parent.textContent = (position.symbol || position.name || '?').charAt(0).toUpperCase()
                                  }
                                }}
                              />
                            ) : ((position.symbol || position.name || '?').charAt(0).toUpperCase())}
                          </div>
                        </div>
                        
                        <div className="flex items-center space-x-1 flex-1 min-w-0">
                          <span className="text-xs text-gray-300 font-medium truncate">
                            {position.symbol || position.name || 'Unknown'}
                          </span>
                        </div>
                      </div>

                      {/* SOL amount */}
                      <div className="text-xs text-gray-300 mb-1">
                        {position.solAmountBought.toFixed(3)} SOL
                      </div>

                      {/* Footer: USD value and indicators */}
                      <div className="flex items-center justify-between text-xs text-gray-400">
                        <span>~${(position.solAmountBought * solPriceUsd).toFixed(0)}</span>
                        <div className="flex items-center space-x-1">
                          {position.tradingSimulation && (
                            <span className="text-purple-300" title="Trading Simulation">SIM</span>
                          )}
                          {position.tradeComparisonData && (
                            <span className="text-cyan-400" title="Trade Comparison Available">📊</span>
                          )}
                          {position.waitingStartedAt && (
                            <span className="text-yellow-400" title="Waiting">⏳</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {!connected && (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm">Connect your wallet to track trading performance</p>
        </div>
      )}

      {/* ✅ NEW: Replace the old share modal with the new modular one */}
      <PnLShareModal
        isOpen={isShareModalOpen}
        onClose={hideShareModal}
        shareData={shareData}
        onCopySuccess={() => console.log('Tweet text copied!')}
      />
    </div>
  )
}