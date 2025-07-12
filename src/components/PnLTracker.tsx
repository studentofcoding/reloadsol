'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { TrackingRecord } from '@/utils/trading-tracker'
import { useWallet, useConnection } from './WalletProvider'
import { useTradingData } from './TradingDataProvider'
import TokenSkeleton from './TokenSkeleton'
import { getSolPriceUSD, SLIPPAGE_OPTIONS, PRIORITY_FEE_OPTIONS } from '@/utils/solana'
import { fetchUserTokens, executeBulkSell, BulkSellRequest, UserToken, TokenToSell } from '@/utils/jupiter'
import { trackSell } from '@/utils/operations-api'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
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
      // -------------------------------------------------------------------------------
      // Legacy aggregation logic (kept for reference, now bypassed)
      // Create position tracking maps to combine multiple buys/sells
      const tokenPositions = new Map<string, {
        mintAddress: string
        symbol?: string
        name?: string
        logoURI?: string
        totalSolBought: number
        totalSolSold: number
        totalTokenAmount: number
        remainingTokenAmount: number
        weightedAvgBuyPrice: number
        weightedAvgSellPrice: number
        firstBuyTimestamp: number
        lastSellTimestamp?: number
        buySignatures: string[]
        sellSignatures: string[]
        transactions: Array<{
          type: 'buy' | 'sell'
          timestamp: number
          solAmount: number
          tokenAmount: number
          priceUsd?: number
          signatures: string[]
        }>
      }>()

      // Process all buy records to build positions
      buyRecords.forEach(buyRecord => {
        buyRecord.tokens.forEach(buyToken => {
          if (!buyRecord.solAmount) return
          
          const solPerToken = buyRecord.solAmount / buyRecord.successCount
          const position = tokenPositions.get(buyToken.mintAddress)
          
          if (position) {
            // Add to existing position
            const newTotalSol = position.totalSolBought + solPerToken
            const newTotalTokens = position.totalTokenAmount + (buyToken.tokenAmount || 0)
            
            // Update weighted average buy price
            if (buyToken.priceUsd && buyToken.priceUsd > 0) {
              const currentWeight = position.totalSolBought
              const newWeight = solPerToken
              const totalWeight = currentWeight + newWeight
              
              if (position.weightedAvgBuyPrice > 0) {
                position.weightedAvgBuyPrice = 
                  (position.weightedAvgBuyPrice * currentWeight + buyToken.priceUsd * newWeight) / totalWeight
              } else {
                position.weightedAvgBuyPrice = buyToken.priceUsd
              }
            }
            
            position.totalSolBought = newTotalSol
            position.totalTokenAmount = newTotalTokens
            position.remainingTokenAmount = newTotalTokens
            position.buySignatures.push(...buyRecord.signatures)
            position.transactions.push({
              type: 'buy',
              timestamp: buyRecord.timestamp,
              solAmount: solPerToken,
              tokenAmount: buyToken.tokenAmount || 0,
              priceUsd: buyToken.priceUsd,
              signatures: buyRecord.signatures
            })
          } else {
            // Create new position
            tokenPositions.set(buyToken.mintAddress, {
              mintAddress: buyToken.mintAddress,
              symbol: buyToken.symbol,
              name: buyToken.name,
              logoURI: buyToken.logoURI,
              totalSolBought: solPerToken,
              totalSolSold: 0,
              totalTokenAmount: buyToken.tokenAmount || 0,
              remainingTokenAmount: buyToken.tokenAmount || 0,
              weightedAvgBuyPrice: buyToken.priceUsd || 0,
              weightedAvgSellPrice: 0,
              firstBuyTimestamp: buyRecord.timestamp,
              buySignatures: [...buyRecord.signatures],
              sellSignatures: [],
              transactions: [{
                type: 'buy',
                timestamp: buyRecord.timestamp,
                solAmount: solPerToken,
                tokenAmount: buyToken.tokenAmount || 0,
                priceUsd: buyToken.priceUsd,
                signatures: buyRecord.signatures
              }]
            })
          }
        })
      })

      // Process sell records to update positions
      processedSellRecords.forEach(sellRecord => {
        sellRecord.tokens.forEach(soldToken => {
          const position = tokenPositions.get(soldToken.mintAddress)
          if (!position || !sellRecord.solAmount) return
          
          const solPerToken = sellRecord.solAmount / sellRecord.successCount
          
          // Update weighted average sell price
          if (soldToken.priceUsd && soldToken.priceUsd > 0) {
            const currentSolSold = position.totalSolSold
            const newSolSold = solPerToken
            const totalSolSold = currentSolSold + newSolSold
            
            if (position.weightedAvgSellPrice > 0 && currentSolSold > 0) {
              position.weightedAvgSellPrice = 
                (position.weightedAvgSellPrice * currentSolSold + soldToken.priceUsd * newSolSold) / totalSolSold
            } else {
              position.weightedAvgSellPrice = soldToken.priceUsd
            }
          }
          
          position.totalSolSold += solPerToken
          position.lastSellTimestamp = sellRecord.timestamp
          position.sellSignatures.push(...sellRecord.signatures)
          position.transactions.push({
            type: 'sell',
            timestamp: sellRecord.timestamp,
            solAmount: solPerToken,
            tokenAmount: soldToken.tokenAmount || 0,
            priceUsd: soldToken.priceUsd,
            signatures: sellRecord.signatures
          })
          
          // Reduce remaining token amount using actual token amounts sold
          if (soldToken.tokenAmount && soldToken.tokenAmount > 0) {
            // Use actual token amount sold for accurate remaining calculation
            position.remainingTokenAmount = Math.max(0, 
              position.remainingTokenAmount - soldToken.tokenAmount
            )
          } else if (position.totalSolBought > 0) {
            // Fallback to SOL proportion only if token amount is not available
            const sellProportion = Math.min(1, solPerToken / position.totalSolBought)
            const estimatedTokensSold = position.totalTokenAmount * sellProportion
            position.remainingTokenAmount = Math.max(0, 
              position.remainingTokenAmount - estimatedTokensSold
            )
          }
        })
      })

      const pnlData: PnLRecord[] = []
      let openData: OpenPosition[] = []

      // Fetch current wallet tokens to verify open positions
      let currentWalletTokens: UserToken[] = []
      try {
        currentWalletTokens = await fetchUserTokens(connection, publicKey!, false, false)
        console.log('🔍 Fetched current wallet tokens:', currentWalletTokens.length, 'tokens found')
      } catch (error) {
        console.error('⚠️ Failed to fetch wallet tokens for position verification:', error)
        // Continue with empty array - will filter out all open positions
      }

            // Generate P&L records and open positions using DIRECT SOL amounts (like TradingHistory)
      tokenPositions.forEach((position, mintAddress) => {
        const totalSolBought = position.totalSolBought
        const totalSolSold = position.totalSolSold
        
        console.log(`📊 Position ${position.symbol}: ${totalSolBought.toFixed(4)} SOL invested, ${totalSolSold.toFixed(4)} SOL received`)
        
        // Create P&L record using ACTUAL SOL amounts (no proportional calculations)
        if (totalSolSold > 0) {
          // Simple, accurate P&L calculation using actual transaction SOL amounts
          const pnlSOL = totalSolSold - totalSolBought
          const pnlPercentage = totalSolBought > 0 ? (pnlSOL / totalSolBought) * 100 : 0
          const pnlUSD = pnlSOL * solPriceUsd
          
          // Determine if partial sell by checking wallet for remaining tokens
          const walletToken = currentWalletTokens.find(token => token.mintAddress === position.mintAddress)
          const hasRemainingTokens = !!(walletToken && walletToken.uiAmount > 0.001)
          
          // Use the most recent sell transaction for timestamps and signatures
          const sellTransactions = position.transactions.filter(t => t.type === 'sell')
          const mostRecentSell = sellTransactions[sellTransactions.length - 1]
          
          const pnlRecord: PnLRecord = {
            id: `${mintAddress}-direct`,
            mintAddress: position.mintAddress,
            symbol: position.symbol,
            name: position.name,
            logoURI: position.logoURI,
            buyTimestamp: position.firstBuyTimestamp,
            sellTimestamp: mostRecentSell.timestamp,
            buyPrice: position.weightedAvgBuyPrice || 0,
            sellPrice: position.weightedAvgSellPrice || 0,
            solAmountBought: totalSolBought,     // ACTUAL total SOL spent
            solAmountSold: totalSolSold,         // ACTUAL total SOL received
            pnlSOL,                              // Simple: received - spent
            pnlUSD,
            pnlPercentage,
            buySignatures: position.buySignatures,
            sellSignatures: position.sellSignatures,
            isPartialSell: hasRemainingTokens,   // Based on actual wallet balance
            sellTransactionId: `${mintAddress}-direct-${mostRecentSell.timestamp}`
          }

          pnlData.push(pnlRecord)
          
          console.log(`💰 Direct P&L for ${position.symbol}: ${totalSolSold.toFixed(4)} - ${totalSolBought.toFixed(4)} = ${pnlSOL.toFixed(4)} SOL (${pnlPercentage.toFixed(1)}%)`)
        }
        
        // Show as open position ONLY if user has tokens in wallet AND no sells have occurred
        // For partial sells, the P&L record shows the complete transaction history
        const walletToken = currentWalletTokens.find(token => token.mintAddress === position.mintAddress)
        if (walletToken && walletToken.uiAmount > 0.001 && totalSolSold === 0) {
          // This is a pure open position (bought but never sold)
          console.log(`✅ Open position for ${position.symbol}: ${totalSolBought.toFixed(4)} SOL invested, no sells yet`)
          
          const openPosition: OpenPosition = {
            id: `open-${mintAddress}`,
            mintAddress: position.mintAddress,
            symbol: position.symbol || walletToken.symbol,
            name: position.name || walletToken.name,
            logoURI: position.logoURI || walletToken.logoURI,
            buyTimestamp: position.firstBuyTimestamp,
            solAmountBought: totalSolBought,  // Full original investment
            buySignatures: position.buySignatures,
            isOpen: true,
            buyPriceUsd: position.weightedAvgBuyPrice,
            buyTokenAmount: position.totalTokenAmount,
            actualWalletBalance: walletToken.uiAmount,
            walletTokenData: walletToken
          }
          openData.push(openPosition)
          console.log(`✅ Pure open position: ${position.symbol || walletToken.symbol} - SOL Investment: ${totalSolBought.toFixed(4)}, Wallet: ${walletToken.uiAmount.toFixed(4)}`)
        } else if (walletToken && walletToken.uiAmount > 0.001 && totalSolSold > 0) {
          console.log(`ℹ️ ${position.symbol} has remaining tokens but is tracked in P&L (partial sell completed)`)
        } else {
          console.log(`❌ Skipping open position: ${position.symbol} - Token not found in wallet or zero balance`)
        }
      })

      // Sort by timestamp (most recent first)
      pnlData.sort((a, b) => b.sellTimestamp - a.sellTimestamp)
      openData.sort((a, b) => b.buyTimestamp - a.buyTimestamp)
      
      // Summary and validation
      const positionSummary = Array.from(tokenPositions.entries()).map(([mint, pos]) => {
        const pnlRecord = pnlData.find(p => p.mintAddress === mint)
        const openPosition = openData.find(o => o.mintAddress === mint)
        
        return {
          token: pos.symbol || mint.slice(0, 8) + '...',
          totalBought: pos.totalSolBought.toFixed(4),
          totalSold: pos.totalSolSold.toFixed(4),
          hasPnL: !!pnlRecord,
          isOpen: !!openPosition,
          status: pos.totalSolSold > 0 ? 'sold' : 'holding'
        }
      })
      
      console.log('📊 Direct P&L Calculation Summary:', {
        totalPositions: tokenPositions.size,
        completedTrades: pnlData.length,
        openPositions: openData.length,
        positionSummary
      })
      
      console.log('✅ Using direct SOL amounts - no allocation math needed!')
      
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
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                } flex items-center space-x-1`}
                title="Refresh wallet balances and current prices for open positions"
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
                          <span className="text-sm text-white font-medium">
                            {record.symbol || record.name || 'Token'}
                          </span>
                        </div>
                        <div className="flex items-center space-x-1">
                          {record.isBotOperation && (
                            <span className="text-xs px-1.5 py-0.5 bg-blue-900/50 text-blue-300 rounded" title={`Bot Strategy: ${record.botStrategy || 'Unknown'}`}>
                              BOT
                            </span>
                          )}
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
                  >
                    {/* Action buttons overlay */}
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex space-x-1 z-20">
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
                            : 'bg-red-500 hover:bg-red-600'
                        }`}
                        title={sellingTokenId === position.id ? 'Selling...' : 'Sell position'}
                        disabled={sellingTokenId === position.id}
                      >
                        {sellingTokenId === position.id ? (
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
                        <span className="text-sm text-white font-medium">
                          {position.symbol || position.name || 'Token'}
                        </span>
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
    </div>
  )
}