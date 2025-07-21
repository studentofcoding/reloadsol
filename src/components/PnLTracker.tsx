'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { TrackingRecord } from '@/utils/trading-tracker'
import { useWallet, useConnection } from './WalletProvider'
import { useTradingData } from './TradingDataProvider'
import TokenSkeleton from './TokenSkeleton'
import { getSolPriceUSD } from '@/utils/solana'
import { fetchUserTokens, executeBulkSell, BulkSellRequest, UserToken, TokenToSell } from '@/utils/jupiter'
import { SwapQuote } from '@/types'
import { trackSell } from '@/utils/operations-api'
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

  // Share functionality state
  const [showShareModal, setShowShareModal] = useState<boolean>(false)
  const [shareData, setShareData] = useState<{
    coinName: string, 
    profitPercentage: number, 
    type: 'profit' | 'loss',
    tokenAddress?: string
  } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Sell quote state
  const [sellQuotes, setSellQuotes] = useState<Map<string, SwapQuote>>(new Map())
  const [quotingTokenId, setQuotingTokenId] = useState<string>('')
  const [quoteTimeouts, setQuoteTimeouts] = useState<Map<string, NodeJS.Timeout>>(new Map())

  // ✅ NEW: Bot operation sync state
  const [lastBotSync, setLastBotSync] = useState<number>(0)
  const [isBotSyncActive, setIsBotSyncActive] = useState<boolean>(false)

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

  // ✅ NEW: Sync status indicator
  const SyncStatusIndicator = () => {
    if (!isBotSyncActive) return null
    
    return (
      <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 mb-4">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
        <span>Syncing bot operations...</span>
      </div>
    )
  }

  // Clear old localStorage data on component mount
  useEffect(() => {
    console.log('🧹 PnLTracker: Cleared old localStorage data, now using Supabase!')
  }, [])

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
  }, [connected, publicKey, lastBotSync])

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

                closedCycles.push({
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
                })

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
  }, [connected, publicKey, solPriceUsd])

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

  // Enhanced function to generate share image with token address
  const generateShareImage = async (coinName: string, profitPercentage: number, tokenAddress?: string): Promise<string> => {
    return new Promise((resolve) => {
      const canvas = canvasRef.current
      if (!canvas) return resolve('')
      
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve('')
      
      const img = new Image()
      img.onload = () => {
        // Use the original image dimensions instead of fixed size
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        
        // Draw background image at original size
        ctx.drawImage(img, 0, 0)
        
        // Set text styles for left middle alignment
        ctx.textAlign = 'left'
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = '#000000'
        ctx.lineWidth = 2
        
        // Left margin for text positioning (scale with image width)
        const leftMargin = canvas.width * 0.0625 // 50px for 800px width, scales proportionally
        const middleY = canvas.height / 2
        
        // Scale font sizes based on canvas width
        const baseWidth = 800
        const scaleFactor = canvas.width / baseWidth
        
        // Draw coin name (top of middle section)
        ctx.font = `bold ${Math.round(36 * scaleFactor)}px Arial`
        const coinText = coinName.toUpperCase()
        ctx.strokeText(coinText, leftMargin, middleY - (80 * scaleFactor))
        ctx.fillText(coinText, leftMargin, middleY - (80 * scaleFactor))
        
        // Prepare profit percentage text
        ctx.font = `bold ${Math.round(64 * scaleFactor)}px Arial`
        const profitText = `${profitPercentage > 0 ? '+' : ''}${profitPercentage.toFixed(1)}%`
        
        // Measure text to create background rectangle
        const textMetrics = ctx.measureText(profitText)
        const textWidth = textMetrics.width
        const textHeight = Math.round(64 * scaleFactor)
        
        // Draw semi-transparent black background for profit percentage
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)' // 80% transparent black
        const padding = 10 * scaleFactor
        ctx.fillRect(
          leftMargin - padding, 
          middleY - textHeight + padding, 
          textWidth + (padding * 2), 
          textHeight + padding
        )
        
        // Draw profit percentage (center of middle section)
        ctx.fillStyle = profitPercentage > 0 ? '#10B981' : '#EF4444'
        ctx.strokeText(profitText, leftMargin, middleY)
        ctx.fillText(profitText, leftMargin, middleY)
        
        // Draw token address (bottom of middle section) if provided
        if (tokenAddress) {
          ctx.font = `bold ${Math.round(20 * scaleFactor)}px Arial`
          ctx.fillStyle = '#ffffff'
          const shortAddress = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-6)}`
          ctx.strokeText(shortAddress, leftMargin, middleY + (80 * scaleFactor))
          ctx.fillText(shortAddress, leftMargin, middleY + (80 * scaleFactor))
        }
        
        // Convert to data URL
        resolve(canvas.toDataURL('image/png'))
      }
      
      img.src = '/profit_share.png'
    })
  }

  // Function to handle share
  const handleShare = async (coinName: string, profitPercentage: number, tokenAddress?: string) => {
    setShareData({ 
      coinName, 
      profitPercentage, 
      type: profitPercentage > 0 ? 'profit' : 'loss',
      tokenAddress 
    })
    setShowShareModal(true)
  }

  // Function to share to Twitter
  const shareToTwitter = async () => {
    if (!shareData) return
    
    const imageDataUrl = await generateShareImage(
      shareData.coinName, 
      shareData.profitPercentage,
      shareData.tokenAddress
    )
    
    // Create simplified tweet text
    const tweetText = `Just ${shareData.type === 'profit' ? 'made' : 'took'} ${shareData.profitPercentage > 0 ? '+' : ''}${shareData.profitPercentage.toFixed(1)}% on $${shareData.coinName}! 🚀\n\n check other recommended coin only on https://v2.reloadsol.xyz/buy`
    
    // Open image in new tab with download instructions
    const newWindow = window.open('', '_blank')
    if (newWindow) {
      newWindow.document.write(`
        <html>
          <head>
            <title>${shareData.coinName} Trading Result</title>
            <style>
              body { 
                margin: 0; 
                padding: 20px; 
                background: #000; 
                color: #fff; 
                font-family: Arial, sans-serif;
                text-align: center;
              }
              img { 
                max-width: 100%; 
                height: auto; 
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(255,255,255,0.1);
                margin-bottom: 20px;
              }
              .instructions {
                margin-top: 20px;
                padding: 20px;
                background: #1a1a1a;
                border-radius: 8px;
                border: 1px solid #333;
                max-width: 600px;
                margin: 20px auto;
              }
              .step {
                margin: 15px 0;
                padding: 10px;
                background: #2a2a2a;
                border-radius: 6px;
                text-align: left;
              }
              .tweet-text {
                background: #2a2a2a;
                padding: 15px;
                border-radius: 6px;
                margin: 15px 0;
                font-family: monospace;
                word-break: break-word;
                text-align: left;
              }
              button {
                background: #1d9bf0;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 25px;
                cursor: pointer;
                margin: 10px;
                font-size: 16px;
                font-weight: bold;
              }
              button:hover { background: #1a8cd8; }
              .download-btn {
                background: #10B981;
                font-size: 18px;
                padding: 15px 30px;
              }
              .download-btn:hover { background: #059669; }
            </style>
          </head>
          <body>
            <h1>🚀 ${shareData.coinName} Trading Result</h1>
            <img src="${imageDataUrl}" alt="Trading Result" id="shareImage" />
            
            <div class="instructions">
              <h2>📱 Share to X (Twitter)</h2>
              
              <div class="step">
                <strong>Step 1:</strong> Download the image above
              </div>
              <button class="download-btn" onclick="downloadImage()">📥 Download Image</button>
              
              <div class="step">
                <strong>Step 2:</strong> Copy the tweet text below
              </div>
              <div class="tweet-text">${tweetText}</div>
              <button onclick="copyText()">📋 Copy Tweet Text</button>
              
              <div class="step">
                <strong>Step 3:</strong> Go to X (Twitter) and create a new post
              </div>
              <button onclick="window.open('https://twitter.com/intent/tweet', '_blank')">🐦 Open X (Twitter)</button>
              
              <div class="step">
                <strong>Step 4:</strong> Paste the text and upload the downloaded image
              </div>
            </div>
            
            <script>
              function downloadImage() {
                const link = document.createElement('a')
                link.download = '${shareData.coinName}_profit_share.png'
                link.href = '${imageDataUrl}'
                link.click()
              }
              
              function copyText() {
                navigator.clipboard.writeText('${tweetText.replace(/'/g, "\\''").replace(/\n/g, '\\n')}')
                alert('Tweet text copied to clipboard!')
              }
            </script>
          </body>
        </html>
      `)
    }
    
    setShowShareModal(false)
  }

  // Function to download the image
  const downloadImage = async () => {
    if (!shareData) return
    
    const imageDataUrl = await generateShareImage(
      shareData.coinName, 
      shareData.profitPercentage,
      shareData.tokenAddress
    )
    
    const link = document.createElement('a')
    link.download = `${shareData.coinName}_profit_share.png`
    link.href = imageDataUrl
    link.click()
    
    setShowShareModal(false)
  }

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
        priorityFee: 30000, // 0.0003 SOL priority fee (default)
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
    <div className="space-y-6">
      {/* Header with sync status */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          P&L Tracker
        </h2>
        <SyncStatusIndicator />
      </div>

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

      {/* Token Chart Section */}
      {selectedToken && (
        <div className="space-y-3 mb-6">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-2">
              <label className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                Token Chart
              </label>
              <button
                onClick={() => setSelectedToken('')}
                className="text-xs text-gray-400 hover:text-white flex items-center"
              >
                <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
                Close
              </button>
            </div>
            <span className="text-xs font-mono text-gray-400">{selectedToken}</span>
          </div>
          <div className="bg-gray-800 border border-gray-600 rounded-xl p-0 overflow-hidden relative">
            {isChartLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-75 z-10">
                <div className="w-8 h-8 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
              </div>
            )}
            <iframe 
              src={`https://www.gmgn.cc/kline/sol/${selectedToken}?interval=1D`}
              height="400"
              className="w-full"
              style={{ border: 'none' }}
              title={`Birdeye Chart - ${selectedToken}`}
              onLoad={() => setIsChartLoading(false)}
              allowFullScreen
              frameBorder="0"
            />
          </div>
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
              Positions ({openPositions.length}) 
              {openPositions.length > 0 && <span className="text-green-400 ml-1">⚡</span>}
            </button>
            {activeTab === 'open' && openPositions.length > 0 && (
              <button
                onClick={async () => {
                  console.log('🔄 Manual refresh triggered by user')
                  await refreshWalletBalances()
                  refreshOpenPositionPrices()
                }}
                disabled={isRefreshingPrices}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  isRefreshingPrices 
                    ? 'bg-gray-600 text-white opacity-50 cursor-not-allowed'
                    : isBotSyncActive
                      ? 'bg-green-600 text-white'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                } flex items-center space-x-1`}
                title={isBotSyncActive ? 'Bot operation detected - syncing...' : 'Refresh wallet balances and current prices for open positions'}
              >
                <svg 
                  className={`w-3 h-3 ${isRefreshingPrices || isBotSyncActive ? 'animate-spin' : ''}`} 
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
                {isBotSyncActive && <span className="text-xs">🤖</span>}
              </button>
            )}
          </div>

          {/* Content based on active tab */}
          {activeTab === 'completed' ? (
            // Completed PnL Records
            pnlRecords.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-gray-400 text-sm">Buy and sell tokens to track your completed trades</p>
                <p className="text-gray-500 text-xs mt-1">💡 Each sell creates a separate P&L record, including partial sells</p>
              </div>
            ) : (
              <>
                <div className="text-center py-2 mb-2">
                  <p className="text-gray-400 text-xs">💡 Below is your Closed Positions for the past 7 days</p>
                </div>
                <div className="flex space-x-0 overflow-x-auto mb-3 scrollbar-hide">
                  {pnlRecords.slice(0, 10).map((record) => (
                    <div
                      key={record.id}
                      className="flex-shrink-0 p-0 hover:bg-gray-700/40 transition-all duration-200 min-w-[180px] rounded-lg group p-4 relative"
                    >
                      {/* Action buttons overlay */}
                      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex space-x-2 sm:space-x-3">
                        <button
                          onClick={() => handleShare(
                            record.symbol || record.name || 'Token', 
                            record.pnlPercentage,
                            record.mintAddress
                          )}
                          className="p-1.5 sm:p-1 bg-green-600 hover:bg-green-500 rounded text-white"
                          title="Share on Twitter"
                        >
                          <svg className="w-8 h-8 sm:w-3 sm:h-3" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                          </svg>
                        </button>
                        <button
                          onClick={() => handleSelectToken(record.mintAddress)}
                          className="p-1.5 sm:p-1 bg-gray-600 hover:bg-gray-500 rounded text-white"
                          title="View chart"
                        >
                          <svg className="w-8 h-8 sm:w-3 sm:h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => openTransactionOnSolscan(record.sellSignatures)}
                          className="p-1.5 sm:p-1 bg-gray-600 hover:bg-gray-500 rounded text-white"
                          title="View on Solscan"
                        >
                          <svg 
                            className="w-8 h-8 sm:w-3 sm:h-3" 
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
                        </button>
                      </div>

                      {/* Line 1: Timestamp and Status */}
                      <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                        <span>{formatRelativeTime(record.sellTimestamp)}</span>
                        <div className="flex items-center space-x-1">
                          {record.status && record.status !== 'tracking' && (
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                              record.status === 'waiting' ? 'bg-yellow-900/50 text-yellow-300' :
                              record.status === 'won' ? 'bg-green-900/50 text-green-300' :
                              record.status === 'lost' ? 'bg-red-900/50 text-red-300' :
                              record.status === 'skipped' ? 'bg-gray-900/50 text-gray-300' :
                              'bg-blue-900/50 text-blue-300'
                            }`}>
                              {record.status.toUpperCase()}
                            </span>
                          )}
                        </div>
                      </div>
                      
                      {/* Line 2: Token and Bot/Simulation Indicators */}
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
                                  const parent = e.currentTarget.parentElement as HTMLElement | null
                                  if (parent) {
                                    parent.textContent = (record.symbol || record.name || '?').charAt(0).toUpperCase()
                                  }
                                }} 
                              />
                            ) : (
                              <span className="text-white text-xs font-bold">
                                {(record.symbol || record.name || '?').charAt(0).toUpperCase()}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-white font-medium">
                                {record.symbol || record.name || 'Token'}
                              </span>
                              {/* ✅ NEW: Bot operation indicator */}
                              <BotOperationIndicator 
                                isBotOperation={record.isBotOperation} 
                                botStrategy={record.botStrategy} 
                              />
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center space-x-1">
                          {record.tradingSimulation && (
                            <span className="text-xs px-1.5 py-0.5 bg-purple-900/50 text-purple-300 rounded" title="Trading Simulation">
                              SIM
                            </span>
                          )}
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
                      
                      {/* Line 4: USD Value and Enhanced Indicators */}
                      <div className="text-xs text-gray-400 mt-0.5 flex justify-between items-center">
                        <span>{record.pnlUSD > 0 ? '+' : ''}${Math.abs(record.pnlUSD).toFixed(2)}</span>
                        <div className="flex items-center space-x-1">
                          {record.isPartialSell && (
                            <span className="text-orange-400 text-xs" title="Partial sell - some tokens remain">⚡</span>
                          )}
                          {!record.isPartialSell && (
                            <span className="text-blue-400 text-xs" title="Complete position closed">🎯</span>
                          )}
                          {record.buyPrice && record.sellPrice && record.buyPrice > 0 && record.sellPrice > 0 && (
                            <span className="text-green-400 text-xs" title="Accurate price data available">✓</span>
                          )}
                          {record.tradeComparisonData && (
                            <span className="text-cyan-400 text-xs" title={`Trade Comparison: ${record.tradeComparisonData.comparison_result || 'Available'}`}>📊</span>
                          )}
                          {record.priceHistory && record.priceHistory.length > 0 && (
                            <span className="text-purple-400 text-xs" title={`Price History: ${record.priceHistory.length} records`}>📈</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )
          ) : (
            // Open Positions
            openPositions.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-gray-400 text-sm">No open positions. Buy tokens to start tracking.</p>
                <p className="text-gray-500 text-xs mt-1">🔄 Positions are combined when you buy the same token multiple times</p>
              </div>
            ) : (
              <>
                <div className="text-center py-2 mb-2">
                  <p className="text-gray-400 text-xs">💡 Hover over positions to see chart and sell options</p>
                </div>
                <div className="flex space-x-0 overflow-x-auto mb-3 scrollbar-hide">
                {openPositions.slice(0, 10).map((position) => (
                  <div
                    key={position.id}
                    className={`flex-shrink-0 transition-all duration-200 min-w-[180px] rounded-lg group p-4 relative ${
                      sellingTokenId === position.id 
                        ? 'bg-red-800/30 border border-red-600' 
                        : 'hover:bg-gray-700/40 border border-transparent'
                    }`}
                    onMouseEnter={() => handlePositionHover(position)}
                    onMouseLeave={() => handlePositionHoverOut(position)}
                  >
                    {/* Action buttons overlay */}
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex space-x-1 z-20">
                      {position.pnlPercentage !== undefined && (
                        <button
                          onClick={() => handleShare(
                            position.symbol || position.name || 'Token', 
                            position.pnlPercentage!,
                            position.mintAddress
                          )}
                          className="p-1.5 sm:p-1 bg-green-600 hover:bg-green-500 rounded text-white"
                          title="Share on Twitter"
                          disabled={sellingTokenId === position.id}
                        >
                          <svg className="w-4 h-4 sm:w-3 sm:h-3" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => handleSelectToken(position.mintAddress)}
                        className="p-1.5 sm:p-1 bg-gray-600 hover:bg-gray-500 rounded text-white"
                        title="View chart"
                        disabled={sellingTokenId === position.id}
                      >
                        <svg className="w-4 h-4 sm:w-3 sm:h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => handleFastSell(position, e)}
                        className={`p-1.5 sm:p-1 rounded text-white transition-colors ${
                          sellingTokenId === position.id 
                            ? 'bg-red-600 cursor-not-allowed' 
                            : sellQuotes.has(position.id)
                              ? 'bg-green-500 hover:bg-green-600'
                              : quotingTokenId === position.id
                                ? 'bg-yellow-500 hover:bg-yellow-600'
                                : 'bg-red-500 hover:bg-red-600'
                        }`}
                        title={
                          sellingTokenId === position.id 
                            ? 'Selling...' 
                            : sellQuotes.has(position.id)
                              ? 'Sell position (Quote ready)'
                              : quotingTokenId === position.id
                                ? 'Fetching quote...'
                                : 'Sell position'
                        }
                        disabled={sellingTokenId === position.id}
                      >
                        {sellingTokenId === position.id ? (
                          <div className="w-4 h-4 sm:w-3 sm:h-3 border border-white border-t-transparent rounded-full animate-spin"></div>
                        ) : quotingTokenId === position.id ? (
                          <div className="w-4 h-4 sm:w-3 sm:h-3 border border-white border-t-transparent rounded-full animate-spin"></div>
                        ) : (
                          <svg className="w-4 h-4 sm:w-3 sm:h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2z" />
                          </svg>
                        )}
                      </button>
                    </div>

                    {/* Loading spinner overlay for selling state */}
                    {sellingTokenId === position.id && (
                      <div className="absolute inset-0 bg-red-900/50 rounded-lg flex items-center justify-center z-10">
                        <div className="w-6 h-6 border-2 border-red-400 border-t-red-200 rounded-full animate-spin"></div>
                      </div>
                    )}

                    {/* Line 1: Timestamp and Status */}
                    <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                      <span>{formatRelativeTime(position.buyTimestamp)}</span>
                      <div className="flex items-center space-x-1">
                        {position.status && position.status !== 'tracking' && (
                          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                            position.status === 'waiting' ? 'bg-yellow-900/50 text-yellow-300' :
                            position.status === 'won' ? 'bg-green-900/50 text-green-300' :
                            position.status === 'lost' ? 'bg-red-900/50 text-red-300' :
                            position.status === 'skipped' ? 'bg-gray-900/50 text-gray-300' :
                            'bg-blue-900/50 text-blue-300'
                          }`}>
                            {position.status.toUpperCase()}
                          </span>
                        )}
                        <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                      </div>
                    </div>
                    
                    {/* Line 2: Token and Bot Indicator */}
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
                                const parent = e.currentTarget.parentElement as HTMLElement | null
                                if (parent) {
                                  parent.textContent = (position.symbol || position.name || '?').charAt(0).toUpperCase()
                                }
                              }} 
                            />
                          ) : (
                            <span className="text-white text-xs font-bold">
                              {(position.symbol || position.name || '?').charAt(0).toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-white font-medium">
                              {position.symbol || position.name || 'Token'}
                            </span>
                            {/* ✅ NEW: Bot operation indicator */}
                            <BotOperationIndicator 
                              isBotOperation={position.isBotOperation} 
                              botStrategy={position.botStrategy} 
                            />
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-1">
                        {position.tradingSimulation && (
                          <span className="text-xs px-1.5 py-0.5 bg-purple-900/50 text-purple-300 rounded" title="Trading Simulation Active">
                            SIM
                          </span>
                        )}
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
                    
                    {/* Line 4: USD Value and Additional Info */}
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
                          <div className="flex items-center space-x-1 ml-1">
                            {position.id.startsWith('open-') && (
                              <span className="text-blue-400 text-xs" title="Combined position from multiple buys">🔗</span>
                            )}
                            {position.tradeComparisonData && (
                              <span className="text-cyan-400 text-xs" title={`Trade Comparison: ${position.tradeComparisonData.comparison_result || 'Available'}`}>📊</span>
                            )}
                            {position.waitingStartedAt && (
                              <span className="text-yellow-400 text-xs" title={`Waiting since: ${new Date(position.waitingStartedAt).toLocaleString()}`}>⏳</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex justify-between items-center">
                          <span>~${(position.solAmountBought * solPriceUsd).toFixed(2)}</span>
                          <div className="flex items-center space-x-1 ml-1">
                            {position.tradeComparisonData && (
                              <span className="text-cyan-400 text-xs" title={`Trade Comparison: ${position.tradeComparisonData.comparison_result || 'Available'}`}>📊</span>
                            )}
                            {position.waitingStartedAt && (
                              <span className="text-yellow-400 text-xs" title={`Waiting since: ${new Date(position.waitingStartedAt).toLocaleString()}`}>⏳</span>
                            )}
                          </div>
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

      {/* Share Modal */}
      {showShareModal && shareData && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-white">Share Your Trade</h3>
              <button
                onClick={() => setShowShareModal(false)}
                className="text-gray-400 hover:text-white"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="mb-6">
              <div className="bg-gray-700 rounded-lg p-4 text-center">
                <div className="text-2xl font-bold text-white mb-2">
                  ${shareData.coinName.toUpperCase()}
                </div>
                <div className={`text-3xl font-bold ${
                  shareData.profitPercentage > 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {shareData.profitPercentage > 0 ? '+' : ''}{shareData.profitPercentage.toFixed(1)}%
                </div>
              </div>
            </div>
            
            <div className="flex space-x-3">
              <button
                onClick={shareToTwitter}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg flex items-center justify-center space-x-2"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
                <span>Tweet</span>
              </button>
              <button
                onClick={downloadImage}
                className="flex-1 bg-gray-600 hover:bg-gray-700 text-white py-2 px-4 rounded-lg flex items-center justify-center space-x-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>Download</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden canvas for image generation */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  )
}