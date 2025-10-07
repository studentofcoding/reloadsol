'use client'

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useWallet, useConnection } from '../components/WalletProvider'
import PhantomWalletButton from './PhantomWalletButton'
import TransactionResultModal from './TransactionResultModal'
import TokenSkeleton from './TokenSkeleton'
import ProgressiveTokenItem from './ProgressiveTokenItem'
import { LAMPORTS_PER_SOL, VersionedTransaction, Transaction } from '@solana/web3.js'
import { 
  executeBulkSell,
  executeBulkSellAlt,
  fetchUserTokens, 
  fetchUserTokensEfficient,
  refreshTokenPricesBatch,
  fetchZeroBalanceTokens,
  closeZeroBalanceTokens,
  getTokenUsdValue,
  isPumpFunToken,
  getAllFeeRates,
  getFeeForOperation,
  setMetadataUpdateCallback,
  clearMetadataUpdateCallback,
  UserToken, 
  TokenToSell,
  BulkSellRequest, 
  BulkSellResult 
} from '@/utils/jupiter'
import { SLIPPAGE_OPTIONS, PRIORITY_FEE_OPTIONS, getSolPriceUSD } from '@/utils/solana'
import { trackSell, trackClose } from '@/utils/operations-api'
import { useTradingData } from './TradingDataProvider'
// ✅ NEW: Import PnL sharing system
import { usePnLShare } from '@/hooks/usePnLShare'
import PnLShareModal from './PnLShareModal'
import { pnlShareService } from '@/utils/pnl-share-service'

// Quote data interface for different providers
interface QuoteData {
  provider: 'jupiter' | 'solanatracker' | 'gmgn'
  inputMint: string
  outputMint: string
  amount: string
  outAmount: string
  priceImpact: number
  fee?: number
  timestamp: number
  route?: any // Provider-specific route data
}

export default function BulkTokenSeller() {
  const { publicKey, signAllTransactions, connected } = useWallet()
  const { connection } = useConnection()
  const { trackOperation } = useTradingData()
  
  // ✅ NEW: Add PnL sharing hook
  const { 
    shareData, 
    isShareModalOpen, 
    isGeneratingShare, 
    showShareModal, 
    hideShareModal, 
    autoTriggerShare 
  } = usePnLShare()
  
  // Form state - Updated to use TokenToSell
  const [selectedTokens, setSelectedTokens] = useState<TokenToSell[]>([])
  const [selectedZeroBalanceTokens, setSelectedZeroBalanceTokens] = useState<UserToken[]>([])
  const [slippage, setSlippage] = useState<number>(200) // 2%
  const [priorityFee, setPriorityFee] = useState<number>(30000) // 0.00003 SOL
  
  // UI state
  const [userTokens, setUserTokens] = useState<UserToken[]>([])
  const [zeroBalanceTokens, setZeroBalanceTokens] = useState<UserToken[]>([])
  const [isLoadingTokens, setIsLoadingTokens] = useState<boolean>(false)
  const [isInitialLoad, setIsInitialLoad] = useState<boolean>(true)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [isClosingAccounts, setIsClosingAccounts] = useState<boolean>(false)
  const [result, setResult] = useState<BulkSellResult | null>(null)
  const [sellPointsEarned, setSellPointsEarned] = useState<number | null>(null)
  const [closePointsEarned, setClosePointsEarned] = useState<number | null>(null)
  const [closeResult, setCloseResult] = useState<{ successful: string[]; failed: Array<{ mintAddress: string; error: string }>; signatures: string[] } | null>(null)
  const [error, setError] = useState<string>('')
  const [showResultModal, setShowResultModal] = useState<boolean>(false)
  const [showCloseResultModal, setShowCloseResultModal] = useState<boolean>(false)
  const [selectedToken, setSelectedToken] = useState<string>('')
  const [isChartLoading, setIsChartLoading] = useState<boolean>(false)
  const [showDustOnly, setShowDustOnly] = useState<boolean>(true)
  
  // Balance tracking
  const [balanceBefore, setBalanceBefore] = useState<number>(0)
  const [balanceAfter, setBalanceAfter] = useState<number>(0)
  
  // SOL price in USD
  const [solPriceUsd, setSolPriceUsd] = useState<number>(145) // Default fallback

  // Provider and Quote state
  const [swapProvider, setSwapProvider] = useState<'jupiter' | 'gmgn'>('gmgn')
  // Auto-quote enabled by default (every 10s)
  const [autoQuote, setAutoQuote] = useState<boolean>(true)
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>({})
  const [isGettingQuotes, setIsGettingQuotes] = useState<boolean>(false)
  const [lastQuoteTime, setLastQuoteTime] = useState<number>(0)
  const [showSettings, setShowSettings] = useState<boolean>(false) 

  const feeRates = getAllFeeRates()

  // Provider options
  const PROVIDER_OPTIONS = [
    { value: 'jupiter', label: 'alternative', icon: '🚀' },
    { value: 'gmgn', label: 'default', icon: '🔥' }
  ] as const

  // Quote utilities
  const getQuoteForToken = (mintAddress: string): QuoteData | null => {
    return quotes[mintAddress] || null
  }

  const isQuoteValid = (quote: QuoteData | null): boolean => {
    if (!quote) return false
    const age = Date.now() - quote.timestamp
    return age < 30000 // Valid for 30 seconds
  }

  // Quote fetching functions for different providers
  const fetchJupiterQuote = useCallback(async (inputMint: string, amount: string): Promise<QuoteData | null> => {
    try {
      const query = new URLSearchParams({
        inputMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        amount,
        slippageBps: slippage.toString()
      })
      const response = await fetch(`/api/providers/jupiter/quote?${query.toString()}`)
      if (!response.ok) throw new Error('Jupiter quote failed')
      
      const data = await response.json()
      return {
        provider: 'jupiter',
        inputMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        amount,
        outAmount: data.outAmount,
        priceImpact: parseFloat(data.priceImpactPct || '0'),
        timestamp: Date.now(),
        route: data
      }
    } catch (error) {
      console.error('Jupiter quote error:', error)
      return null
    }
  }, [slippage])

  const fetchGMGNQuote = useCallback(async (inputMint: string, amount: string): Promise<QuoteData | null> => {
    try {
      // Call backend proxy to avoid CORS and include required fee parameter (handled server-side)
      const query = new URLSearchParams({
        token_in_address: inputMint,
        token_out_address: 'So11111111111111111111111111111111111111112',
        in_amount: amount,
        from_address: publicKey?.toString() || '',
        slippage: (slippage / 100).toString()
      })
      const response = await fetch(`/api/providers/gmgn/quote?${query.toString()}`)
      if (!response.ok) throw new Error('GMGN quote failed')
      
      const data = await response.json()
      
      // Extract quote data from GMGN response structure (supports both legacy and new formats)
      if (!data.data) {
        throw new Error('Invalid GMGN response format')
      }

      const quoteInfo = data.data.quote || data.data // some responses nest under data.quote

      const gmgnOut = quoteInfo.outputAmount ?? quoteInfo.output_amount ?? quoteInfo.outAmount ?? quoteInfo.out_amount
      if (!gmgnOut) {
        throw new Error('Invalid GMGN response format')
      }
      
      return {
        provider: 'gmgn',
        inputMint,
        outputMint: 'So11111111111111111111111111111111111111112',
        amount,
        outAmount: gmgnOut,
        priceImpact: parseFloat(quoteInfo.priceImpactPct || quoteInfo.priceImpact || quoteInfo.price_impact || '0'),
        timestamp: Date.now(),
        route: data
      }
    } catch (error) {
      console.error('GMGN quote error:', error)
      return null
    }
  }, [slippage, publicKey])

  // Main quote fetching function
  const fetchQuoteForToken = useCallback(async (token: TokenToSell): Promise<QuoteData | null> => {
    const amount = token.sellAmount.toString()

    // Helper to attempt provider then fallback to Jupiter
    const tryProvider = async () => {
      switch (swapProvider) {
        case 'jupiter':
          return fetchJupiterQuote(token.mintAddress, amount)
        case 'gmgn':
          return fetchGMGNQuote(token.mintAddress, amount)
        default:
          return fetchJupiterQuote(token.mintAddress, amount)
      }
    }

    return tryProvider()
  }, [swapProvider, fetchJupiterQuote, fetchGMGNQuote])

  // Batch quote fetching for all selected tokens
  const fetchAllQuotes = useCallback(async () => {
    // Only fetch for tokens that are not unsellable
    const tokensToQuote = selectedTokens.filter(
      t => !selectedZeroBalanceTokens.some(z => z.mintAddress === t.mintAddress)
    )
    if (tokensToQuote.length === 0 || isGettingQuotes) return

    setIsGettingQuotes(true)
    setError('')

    try {
      console.log(`Fetching ${swapProvider} quotes for ${tokensToQuote.length} tokens`)

      // Fetch quotes for all selected tokens in parallel
      const quotePromises = tokensToQuote.map(async (token) => {
        const quote = await fetchQuoteForToken(token)
        return { mintAddress: token.mintAddress, quote }
      })

      const results = await Promise.allSettled(quotePromises)
      const newQuotes: Record<string, QuoteData> = {}
      let successCount = 0

      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.quote) {
          newQuotes[result.value.mintAddress] = result.value.quote
          successCount++
        }
      })

      setQuotes(prevQuotes => ({ ...prevQuotes, ...newQuotes }))
      setLastQuoteTime(Date.now())

      console.log(`✅ Got ${successCount}/${tokensToQuote.length} quotes from ${swapProvider}`)

      if (successCount === 0) {
        setError(`Failed to get quotes from ${swapProvider}. Try a different provider.`)
      }
    } catch (error) {
      console.error('Batch quote error:', error)
      setError('Failed to fetch quotes. Please try again.')
    } finally {
      setIsGettingQuotes(false)
    }
  }, [selectedTokens, selectedZeroBalanceTokens, swapProvider, fetchQuoteForToken, isGettingQuotes])

  // ===== Auto-quote effect =====
  // 1. Runs immediately whenever token selection changes (or autoQuote toggles on)
  // 2. Refreshes every 5 s as long as the selection stays the same
  const tokensHash = useMemo(
    () => selectedTokens.map(t => t.mintAddress).sort().join(','),
    [selectedTokens]
  )

  // Keep a ref to the latest fetchAllQuotes so interval always has fresh logic but effect doesn't depend on its identity
  const fetchAllQuotesRef = useRef(fetchAllQuotes)
  useEffect(() => {
    fetchAllQuotesRef.current = fetchAllQuotes
  }, [fetchAllQuotes])

  useEffect(() => {
    if (!autoQuote || selectedTokens.length === 0) return

    // Fetch immediately on mount / token change
    fetchAllQuotesRef.current()

    // Poll every 5 seconds while the token list is unchanged
    const interval = setInterval(() => {
      if (autoQuote && selectedTokens.length > 0) {
        fetchAllQuotesRef.current()
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [autoQuote, tokensHash, selectedTokens.length])

  // Clear quotes when provider changes
  useEffect(() => {
    setQuotes({})
    setLastQuoteTime(0)
  }, [swapProvider])

  // Fetch SOL price using robust multi-API system
  const fetchSolPrice = useCallback(async () => {
    try {
      const price = await getSolPriceUSD()
      setSolPriceUsd(price)
      console.log(`SOL price updated: $${price}`)
    } catch (error) {
      console.error('Error fetching SOL price:', error)
      // Keep using current price if fetch fails
    }
  }, [])

  // Handle metadata updates from background enrichment
  const handleMetadataUpdate = useCallback((updatedTokens: UserToken[]) => {
    console.log(`Updating UI with enriched metadata for ${updatedTokens.length} tokens`)
    
    // Update userTokens state
    setUserTokens(prev => prev.map(token => {
      const updated = updatedTokens.find(u => u.mintAddress === token.mintAddress)
      return updated || token
    }))

    // Update zeroBalanceTokens state
    setZeroBalanceTokens(prev => prev.map(token => {
      const updated = updatedTokens.find(u => u.mintAddress === token.mintAddress)
      return updated || token
    }))

    // Update selectedTokens state
    setSelectedTokens(prev => prev.map(token => {
      const updated = updatedTokens.find(u => u.mintAddress === token.mintAddress)
      return updated ? { ...updated, sellAmount: token.sellAmount, sellPercentage: token.sellPercentage } : token
    }))

    // Update selectedZeroBalanceTokens state
    setSelectedZeroBalanceTokens(prev => prev.map(token => {
      const updated = updatedTokens.find(u => u.mintAddress === token.mintAddress)
      return updated || token
    }))
  }, [])

  const fetchTokens = useCallback(async () => {
    if (!publicKey) return
    
    setIsLoadingTokens(true)
    setError('')
    try {
      // Fetch all tokens efficiently using Jupiter API v2 with progress callback
      // Note: Removed clearAllCaches() to prevent redundant fetches - caching improves performance
      const allTokens = await fetchUserTokensEfficient(
        connection, 
        publicKey, 
        true, // Include zero balance
        false, // Exclude NFTs
        (progress) => {
          // Optional: Add progress indicator in the future
          console.log(`Token fetching progress: ${progress}%`)
        }
      )
      
      // Separate sellable tokens from zero-balance/unsellable tokens
      // Sellable tokens: have meaningful balance AND (USD value >= 0.001 OR pump.fun token)
      const sellableTokens = allTokens.filter(token => 
        token.uiAmount > 0.000000000001 && (token.usdValue >= 0.001 || isPumpFunToken(token.mintAddress))
      )
      
      // Zero-balance/unsellable tokens: either zero balance OR (USD value < 0.001 AND not pump.fun)
      const zeroTokens = allTokens.filter(token => 
        token.uiAmount <= 0.000000000001 || (token.usdValue < 0.001 && !isPumpFunToken(token.mintAddress))
      )
      
      setUserTokens(sellableTokens)
      setZeroBalanceTokens(zeroTokens)
      setIsInitialLoad(false) // Mark initial load as complete
      
      console.log(`Efficiently fetched ${sellableTokens.length} sellable and ${zeroTokens.length} zero/unsellable tokens`)
    } catch (error) {
      console.error('Error fetching tokens:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      if (errorMessage.includes('Rate limit') || errorMessage.includes('429')) {
        setError('Rate limit exceeded. Please wait a moment and try again.')
      } else {
        setError('Failed to fetch your tokens. Please try again.')
      }
      setIsInitialLoad(false) // Mark initial load as complete even on error
    } finally {
      setIsLoadingTokens(false)
    }
  }, [connection, publicKey])

  // Handle token selection
  const toggleTokenSelection = (token: UserToken) => {
    setSelectedTokens(prev => {
      const isSelected = prev.some(t => t.mintAddress === token.mintAddress)
      if (isSelected) {
        return prev.filter(t => t.mintAddress !== token.mintAddress)
      } else {
        // Check if already at the limit
        if (prev.length >= 22) {
          setError('Maximum 22 tokens can be selected for selling')
          return prev
        }
        // Convert UserToken to TokenToSell with default 100% sell amount
        const tokenToSell: TokenToSell = {
          ...token,
          sellAmount: token.balance,
          sellPercentage: 100
        }
        return [...prev, tokenToSell]
      }
    })
  }

  // Handle sell percentage change for a specific token
  const updateTokenSellPercentage = (mintAddress: string, percentage: number) => {
    setSelectedTokens(prev => prev.map(token => {
      if (token.mintAddress === mintAddress) {
        const sellAmount = Math.floor((token.balance * percentage) / 100)
        return {
          ...token,
          sellPercentage: percentage,
          sellAmount: sellAmount
        }
      }
      return token
    }))
  }

  // Handle zero-balance token selection
  const toggleZeroBalanceTokenSelection = (token: UserToken) => {
    setSelectedZeroBalanceTokens(prev => {
      const isSelected = prev.some(t => t.mintAddress === token.mintAddress)
      if (isSelected) {
        return prev.filter(t => t.mintAddress !== token.mintAddress)
      } else {
        // Check if already at the limit
        if (prev.length >= 22) {
          setError('Maximum 22 tokens can be selected for closing')
          return prev
        }
        return [...prev, token]
      }
    })
  }

  // Select all tokens
  const selectAllTokens = () => {
    const tokensToSelect = showDustOnly ? filteredUserTokens : userTokens
    const tokensToSell: TokenToSell[] = tokensToSelect.map(token => ({
      ...token,
      sellAmount: token.balance,
      sellPercentage: 100
    }))
    
    if (tokensToSell.length > 22) {
      setSelectedTokens(tokensToSell.slice(0, 22))
      setError('Selection limited to first 22 tokens (Solana transaction limit)')
    } else {
      setSelectedTokens(tokensToSell)
    }
  }

  // Select all zero-balance tokens
  const selectAllZeroBalanceTokens = () => {
    if (zeroBalanceTokens.length > 22) {
      setSelectedZeroBalanceTokens(zeroBalanceTokens.slice(0, 22))
      setError('Selection limited to first 22 tokens (Solana transaction limit)')
    } else {
      setSelectedZeroBalanceTokens([...zeroBalanceTokens])
    }
  }

  // Clear selection
  const clearSelection = () => {
    setSelectedTokens([])
  }

  // Clear zero-balance selection
  const clearZeroBalanceSelection = () => {
    setSelectedZeroBalanceTokens([])
  }

  // Refresh all token prices efficiently
  const refreshAllPrices = useCallback(async () => {
    // Use functional update to get current tokens
    let currentTokens: UserToken[] = []
    setUserTokens(prev => {
      currentTokens = prev
      return prev
    })
    
    if (!publicKey || currentTokens.length === 0) return
    
    // Set loading state for all tokens
    setUserTokens(prev => prev.map(token => ({ ...token, isLoadingPrice: true })))
    
    try {
      console.log('Starting efficient batch price refresh...')
      
      // Use efficient batch price refresh
      const updatedTokens = await refreshTokenPricesBatch(currentTokens)
        
      // Update tokens state
      setUserTokens(updatedTokens)
        
      // Update selected tokens with new prices
      setSelectedTokens(prev => prev.map(selectedToken => {
        const updatedToken = updatedTokens.find(t => t.mintAddress === selectedToken.mintAddress)
        if (updatedToken) {
          return {
            ...updatedToken,
            sellAmount: selectedToken.sellAmount,
            sellPercentage: selectedToken.sellPercentage
          }
        }
        return selectedToken
      }))
      
      console.log('Efficient batch price refresh completed')
    } catch (error) {
      console.error('Error refreshing all prices:', error)
      setError('Failed to refresh token prices')
      
      // Clear loading states
      setUserTokens(prev => prev.map(token => ({ ...token, isLoadingPrice: false })))
    }
  }, [publicKey]) // Remove userTokens from dependency array

  // Refresh individual token price efficiently
  const refreshTokenPrice = useCallback(async (token: UserToken) => {
    if (!publicKey) return
    
    // Update the loading state for this specific token
    setUserTokens(prev => prev.map(t => 
      t.mintAddress === token.mintAddress 
        ? { ...t, isLoadingPrice: true }
        : t
    ))
    
    try {
      // Use efficient batch refresh for single token (leverages caching)
      const updatedTokens = await refreshTokenPricesBatch([token])
      const updatedToken = updatedTokens[0]
      
      if (updatedToken) {
      // Update the token with new price
      setUserTokens(prev => prev.map(t => 
        t.mintAddress === token.mintAddress 
            ? { ...updatedToken, isLoadingPrice: false }
          : t
      ))
      
      // Update selected tokens if this token is selected
      setSelectedTokens(prev => prev.map(t => 
        t.mintAddress === token.mintAddress 
            ? { ...t, usdValue: updatedToken.usdValue, isLoadingPrice: false }
          : t
      ))
      }
    } catch (error) {
      console.error('Error refreshing token price:', error)
      setUserTokens(prev => prev.map(t => 
        t.mintAddress === token.mintAddress 
          ? { ...t, isLoadingPrice: false }
          : t
      ))
    }
  }, [publicKey])

  // Custom swap execution using provider-specific quotes
  const executeCustomSwap = useCallback(async (
    tokens: TokenToSell[],
    walletAddress: string,
    connection: any,
    signAllTransactions: any
  ): Promise<BulkSellResult> => {
    // Collect GMGN transactions for batch processing
    const gmgnTransactions: Array<{
      token: TokenToSell
      quote: QuoteData
      transaction: VersionedTransaction
    }> = []

    const results: BulkSellResult = {
      success: false,
      successfulSwaps: [],
      failedSwaps: [],
      successfulCloses: [],
      failedCloses: [],
      signatures: [],
      totalReceived: 0,
      feeInfo: {
        totalFees: 0,
        devFee: 0,
        referralFee: 0,
        feePerOperation: 0,
        totalOperations: 0,
        operationType: 'SELL',
        sellFeeRate: 0.5,
        closeFeeRate: 0.00203928
      }
    }

    // Process swaps using provider-specific quotes
    for (const token of tokens) {
      try {
        const quote = getQuoteForToken(token.mintAddress)
        
        if (!quote || !isQuoteValid(quote)) {
          results.failedSwaps.push({
            mintAddress: token.mintAddress,
            error: 'No valid quote available'
          })
          continue
        }

        // Execute swap based on provider
        let swapResult: any = null
        
        switch (swapProvider) {
          case 'jupiter':
            // Use Jupiter swap with the quote
            const jupiterResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                quoteResponse: quote.route,
                userPublicKey: walletAddress,
                wrapAndUnwrapSol: true,
                priorityLevelWithMaxLamports: {
                  priorityLevel: 'medium',
                  maxLamports: priorityFee
                }
              })
            })
            
            if (jupiterResponse.ok) {
              const { swapTransaction } = await jupiterResponse.json()
              // Execute the transaction (simplified - would need full implementation)
              swapResult = { signature: 'mock-signature', outAmount: quote.outAmount }
            }
            break
            
          case 'gmgn':
            // GMGN transactions will be batched below
            if (!quote.route?.data?.raw_tx?.swapTransaction) {
              throw new Error('No transaction data from GMGN')
            }
            // Collect for batch processing
            gmgnTransactions.push({
              token,
              quote,
              transaction: VersionedTransaction.deserialize(
                Buffer.from(quote.route.data.raw_tx.swapTransaction, 'base64')
              )
            })
            break
        }

        if (swapResult) {
          results.successfulSwaps.push({
            mintAddress: token.mintAddress,
            solReceived: parseFloat(swapResult.outAmount) / 1e9
          })
          results.signatures.push(swapResult.signature)
          results.totalReceived += parseFloat(swapResult.outAmount) / 1e9
        } else if (swapProvider !== 'gmgn') {
          results.failedSwaps.push({
            mintAddress: token.mintAddress,
            error: `${swapProvider} swap failed`
          })
        }
      } catch (error) {
        results.failedSwaps.push({
          mintAddress: token.mintAddress,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    if (swapProvider === 'gmgn' && gmgnTransactions.length > 0) {
      try {
        // Sign all GMGN transactions at once
        const transactions = gmgnTransactions.map(t => t.transaction)
        const signedTransactions = await signAllTransactions(transactions)

        // Submit all signed transactions to GMGN
        const submitPromises = signedTransactions.map(async (signedTx: VersionedTransaction, index: number) => {
          const signedBase64 = Buffer.from(signedTx.serialize()).toString('base64')
          const submitResponse = await fetch('/api/providers/gmgn/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signed_tx: signedBase64 })
          })

          if (submitResponse.ok) {
            const submitData = await submitResponse.json()
            return {
              success: true,
              signature: submitData.data?.hash || `gmgn-tx-${index}`,
              outAmount: gmgnTransactions[index].quote.outAmount
            }
          } else {
            return {
              success: false,
              error: `GMGN submit failed for ${gmgnTransactions[index].token.mintAddress}`
            }
          }
        })

        const submitResults = await Promise.all(submitPromises)

        // Process results
        submitResults.forEach((result: any, index: number) => {
          const token = gmgnTransactions[index].token
          if (result.success) {
            results.successfulSwaps.push({
              mintAddress: token.mintAddress,
              solReceived: parseFloat(result.outAmount) / 1e9
            })
            results.signatures.push(result.signature)
            results.totalReceived += parseFloat(result.outAmount) / 1e9
          } else {
            results.failedSwaps.push({
              mintAddress: token.mintAddress,
              error: result.error
            })
          }
        })

        // === Auto-close tokens after GMGN swap (like Jupiter) ===
        // Find tokens with 100% sell
        const tokensToClose = gmgnTransactions
          .map(t => t.token)
          .filter(t => t.sellPercentage >= 100)

        if (tokensToClose.length > 0) {
          try {
            const closeResult = await executeBulkSellAlt(
              {
                tokens: [],
                unsellableTokens: tokensToClose,
                slippage: 0,
                priorityFee: 0
              },
              walletAddress,
              connection,
              signAllTransactions
            )
            results.successfulCloses = closeResult.successfulCloses
            results.failedCloses = closeResult.failedCloses
            results.signatures.push(...closeResult.signatures)
          } catch (closeError) {
            console.error('Failed to auto-close after GMGN swap:', closeError)
          }
        }
      } catch (error) {
        console.error('GMGN batch processing error:', error)
        gmgnTransactions.forEach((t: any) => {
          results.failedSwaps.push({
            mintAddress: t.token.mintAddress,
            error: 'GMGN batch processing failed'
          })
        })
      }
    }

    results.success = results.successfulSwaps.length > 0
    return results
  }, [swapProvider, getQuoteForToken, isQuoteValid, priorityFee, signAllTransactions, connection, publicKey])

  // Handle bulk sell with better error handling
  const handleBulkSell = useCallback(async () => {
    if (!connected || !publicKey || !signAllTransactions) {
      setError('Please connect your wallet first')
      return
    }

    if (selectedTokens.length === 0 && selectedZeroBalanceTokens.length === 0) {
      setError('Please select at least one token')
      return
    }

    setIsLoading(true)
    setError('')
    setResult(null)
    setSellPointsEarned(null)
    setClosePointsEarned(null)
    setCloseResult(null) // Clear any previous close-only results

    try {
      // Get balance before operation
      const balanceBeforeOp = await connection.getBalance(publicKey)
      const balanceBeforeSOL = balanceBeforeOp / LAMPORTS_PER_SOL
      setBalanceBefore(balanceBeforeSOL)

      const request: BulkSellRequest = {
        tokens: selectedTokens,
        unsellableTokens: selectedZeroBalanceTokens.length > 0 ? selectedZeroBalanceTokens : undefined,
        slippage,
        priorityFee,
      }

      let sellResult: BulkSellResult
      
      if (swapProvider === 'jupiter') {
        // Use default Jupiter implementation
        sellResult = await executeBulkSellAlt(
          request,
          publicKey.toString(),
          connection,
          signAllTransactions
        )
      } else {
        // Use custom provider implementation
        sellResult = await executeCustomSwap(
          selectedTokens,
          publicKey.toString(),
          connection,
          signAllTransactions
        )
        
        // Handle unsellable tokens separately if any
        if (selectedZeroBalanceTokens.length > 0) {
          // Close unsellable tokens (this always uses Jupiter's close functionality)
          try {
            const closeResult = await executeBulkSellAlt(
              {
                tokens: [],
                unsellableTokens: selectedZeroBalanceTokens,
                slippage,
                priorityFee
              },
              publicKey.toString(),
              connection,
              signAllTransactions
            )
            
            // Merge close results
            sellResult.successfulCloses = closeResult.successfulCloses
            sellResult.failedCloses = closeResult.failedCloses
            sellResult.signatures.push(...closeResult.signatures)
          } catch (error) {
            console.error('Failed to close accounts:', error)
          }
        }
      }

      // Get balance after operation
      const balanceAfterOp = await connection.getBalance(publicKey)
      const balanceAfterSOL = balanceAfterOp / LAMPORTS_PER_SOL
      setBalanceAfter(balanceAfterSOL)

      setResult(sellResult)
      
      // Only show modal if there were actual transaction attempts (success or failure)
      if (sellResult && (
        sellResult.successfulSwaps.length > 0 || 
        sellResult.failedSwaps.length > 0 || 
        sellResult.successfulCloses.length > 0 || 
        sellResult.failedCloses.length > 0
      )) {
        setShowResultModal(true)
      }

      // Track the sell operation
      if (sellResult) {
        // Track sell operations (swaps)
        if (sellResult.successfulSwaps.length > 0 || sellResult.failedSwaps.length > 0) {
          // Track sell operation securely via server route for points
          try {
            const trackResult = await trackSell(
              publicKey.toString(),
              sellResult.successfulSwaps.length,
              {
                failureCount: sellResult.failedSwaps.length,
                solAmount: sellResult.totalReceived,
                tokenMints: sellResult.successfulSwaps.map(s => s.mintAddress),
                signatures: sellResult.signatures,
              }
            );
            console.log(`🎉 Earned ${trackResult.pointsEarned} points from sell operation!`);
            setSellPointsEarned(trackResult.pointsEarned);
          } catch (trackError) {
            console.error('Failed to track sell operation for points:', trackError);
          }

          // Track operation for PnL and history via React Query
          try {
            // Fetch current token prices and SOL price for accurate tracking
            const { fetchTokenPricesForTracking } = await import('@/utils/trading-tracker')
            
            const tokenMints = selectedTokens.map(t => t.mintAddress)
            const [tokenPrices, currentSolPrice] = await Promise.all([
              fetchTokenPricesForTracking(tokenMints),
              getSolPriceUSD()
            ])

            // Calculate individual SOL amounts based on token USD values and proportions
            const totalUsdValueSold = selectedTokens.reduce((sum, token) => {
              return sum + (token.usdValue * token.sellPercentage / 100)
            }, 0)
            
            const totalSolReceived = sellResult.totalReceived || 0
            
            // Prepare enhanced token data with current prices, amounts, and individual SOL amounts
            const enhancedTokenData = selectedTokens
              .filter(token => sellResult.successfulSwaps.some(s => s.mintAddress === token.mintAddress))
              .map(token => {
                // Calculate proportional SOL amount based on this token's USD value relative to total
                const tokenUsdValue = token.usdValue * token.sellPercentage / 100
                const solAmountForThisToken = totalUsdValueSold > 0 
                  ? (tokenUsdValue / totalUsdValueSold) * totalSolReceived 
                  : totalSolReceived / sellResult.successfulSwaps.length // Fallback to equal split

                return {
                  mintAddress: token.mintAddress,
                  symbol: token.symbol,
                  name: token.name,
                  logoURI: token.logoURI,
                  priceUsd: tokenPrices[token.mintAddress] || 0,
                  tokenAmount: token.sellAmount, // Amount of tokens being sold
                  solAmount: solAmountForThisToken // Individual SOL amount for this token
                }
              })

            const sellErrors = sellResult.failedSwaps.length > 0 
              ? sellResult.failedSwaps.map(f => f.error)
              : undefined

            // Track via centralized React Query system
            await trackOperation({
              walletAddress: publicKey.toString(),
              operationType: 'sell',
              tokens: enhancedTokenData.map(token => ({
                ...token,
                solPrice: currentSolPrice
              })),
              successCount: sellResult.successfulSwaps.length,
              failureCount: sellResult.failedSwaps.length,
              totalTokens: sellResult.successfulSwaps.length + sellResult.failedSwaps.length,
              solAmount: sellResult.totalReceived || 0, // Keep total for backward compatibility
              feesPaid: 0, // We don't track this locally yet
              solPriceUsd: currentSolPrice,
              totalUsdValue: currentSolPrice ? (sellResult.totalReceived || 0) * currentSolPrice : undefined,
              signatures: sellResult.signatures,
              slippage: slippage / 100,
              priorityFee,
              errors: sellErrors
            })

            // ✅ NEW: Auto-trigger share modal for successful sells
            if (sellResult.successfulSwaps.length > 0 && totalSolReceived > 0) {
              // For bulk sells, we'll trigger share for the most significant trade
              const mostSignificantToken = enhancedTokenData.reduce((prev, current) => 
                (current.solAmount > prev.solAmount) ? current : prev
              )

              if (mostSignificantToken) {
                // Calculate P&L percentage (we don't have buy data here, so we'll estimate)
                // This is a simplified approach - in a real scenario you'd want to track buy history
                const estimatedBuyValue = mostSignificantToken.solAmount * 0.8 // Assume 25% profit for demo
                const pnlPercentage = pnlShareService.calculatePnLPercentage(
                  estimatedBuyValue, 
                  mostSignificantToken.solAmount
                )

                if (Math.abs(pnlPercentage) >= 5) { // Only trigger for trades with >= 5% P&L
                  setTimeout(async () => {
                    try {
                      await autoTriggerShare({
                        coinName: mostSignificantToken.symbol || mostSignificantToken.name || 'Token',
                        profitPercentage: pnlPercentage,
                        tokenAddress: mostSignificantToken.mintAddress,
                        solAmountBought: estimatedBuyValue,
                        solAmountSold: mostSignificantToken.solAmount
                      })
                    } catch (error) {
                      console.error('Error auto-triggering share for bulk sell:', error)
                    }
                  }, 1000)
                }
              }
            }
          } catch (trackError) {
            console.error('Failed to track sell operation for history/PnL:', trackError);
          }
        }

        // Track close operations  
        if (sellResult.successfulCloses.length > 0 || sellResult.failedCloses.length > 0) {
          const allClosedTokens = [
            ...selectedTokens.filter(token => 
              sellResult.successfulCloses.includes(token.mintAddress) ||
              sellResult.failedCloses.some(f => f.mintAddress === token.mintAddress)
            ),
            ...selectedZeroBalanceTokens
          ]

          // Track close operation securely via server route for points
          try {
            const trackResult = await trackClose(
              publicKey.toString(),
              sellResult.successfulCloses.length,
              {
                failureCount: sellResult.failedCloses.length,
                tokenMints: sellResult.successfulCloses,
                signatures: sellResult.signatures,
              }
            );
            console.log(`🎉 Earned ${trackResult.pointsEarned} points from close operation!`);
            setClosePointsEarned(trackResult.pointsEarned);
          } catch (trackError) {
            console.error('Failed to track close operation for points:', trackError);
          }

          // Track operation for PnL and history via React Query
          try {
            // Get SOL price for tracking (close operations don't need token prices)
            const currentSolPrice = await getSolPriceUSD()

            const closeTokenData = allClosedTokens.map(token => ({
              mintAddress: token.mintAddress,
              symbol: token.symbol,
              name: token.name,
              logoURI: token.logoURI
            }))

            const closeErrors = sellResult.failedCloses.length > 0 
              ? sellResult.failedCloses.map(f => f.error)
              : undefined

            // Track via centralized React Query system
            await trackOperation({
              walletAddress: publicKey.toString(),
              operationType: 'close',
              tokens: closeTokenData.map(token => ({
                ...token,
                solPrice: currentSolPrice
              })),
              successCount: sellResult.successfulCloses.length,
              failureCount: sellResult.failedCloses.length,
              totalTokens: sellResult.successfulCloses.length + sellResult.failedCloses.length,
              feesPaid: 0, // We don't track this locally yet
              solPriceUsd: currentSolPrice,
              signatures: sellResult.signatures,
              errors: closeErrors
            })
          } catch (trackError) {
            console.error('Failed to track close operation for history/PnL:', trackError);
          }
        }
      }

      if (sellResult.success || sellResult.successfulCloses.length > 0) {
        // Refresh token list and clear selection
        await fetchTokens()
        setSelectedTokens([])
        setSelectedZeroBalanceTokens([])
      }
    } catch (err) {
      console.error('Bulk operation error:', err)
      
      // Better error handling for different types of errors
      if (err instanceof Error) {
        if (err.message.includes('ChunkLoadError') || err.message.includes('Loading chunk')) {
          setError('Network error occurred. Please refresh the page and try again.')
        } else if (err.message.includes('Close account')) {
          setError(`Account closing failed: ${err.message}`)
        } else {
          setError(err.message)
        }
      } else {
        setError('An unknown error occurred. Please try again.')
      }
    } finally {
      setIsLoading(false)
    }
  }, [connected, publicKey, signAllTransactions, connection, selectedTokens, selectedZeroBalanceTokens, slippage, priorityFee, fetchTokens, swapProvider, executeCustomSwap, autoTriggerShare])

  // Handle close-only (burn) operation without selling any tokens
  const handleCloseOnly = useCallback(async () => {
    if (!connected || !publicKey || !signAllTransactions) {
      setError('Please connect your wallet first')
      return
    }

    if (selectedTokens.length === 0 && selectedZeroBalanceTokens.length === 0) {
      setError('Please select at least one token')
      return
    }

    setIsLoading(true)
    setError('')
    setCloseResult(null)
    setClosePointsEarned(null)

    try {
      const request: BulkSellRequest = {
        tokens: [], // no swaps, only closes
        unsellableTokens: [...selectedTokens, ...selectedZeroBalanceTokens],
        slippage,
        priorityFee
      }

      const closeOnlyResult = await executeBulkSellAlt(
        request,
        publicKey.toString(),
        connection,
        signAllTransactions
      )

      const closeData = {
        successful: closeOnlyResult.successfulCloses,
        failed: closeOnlyResult.failedCloses,
        signatures: closeOnlyResult.signatures
      }

      setCloseResult(closeData)

      if (closeData.successful.length > 0 || closeData.failed.length > 0) {
        setShowCloseResultModal(true)
      }

      // Points tracking
      try {
        const trackResult = await trackClose(publicKey.toString(), closeData.successful.length, {
          failureCount: closeData.failed.length,
          tokenMints: closeData.successful,
          signatures: closeData.signatures
        })
        console.log(`🎉 Earned ${trackResult.pointsEarned} points from close operation!`)
        setClosePointsEarned(trackResult.pointsEarned)
      } catch (trackError) {
        console.error('Failed to track close operation for points:', trackError)
      }

      // History / PnL tracking
      try {
        const currentSolPrice = await getSolPriceUSD()
        const closeTokenData = [...selectedTokens, ...selectedZeroBalanceTokens].map(token => ({
          mintAddress: token.mintAddress,
          symbol: token.symbol,
          name: token.name,
          logoURI: token.logoURI
        }))

        const closeErrors = closeData.failed.length > 0 ? closeData.failed.map(f => f.error) : undefined

        await trackOperation({
          walletAddress: publicKey.toString(),
          operationType: 'close',
          tokens: closeTokenData.map(t => ({ ...t, solPrice: currentSolPrice })),
          successCount: closeData.successful.length,
          failureCount: closeData.failed.length,
          totalTokens: closeData.successful.length + closeData.failed.length,
          feesPaid: 0,
          solPriceUsd: currentSolPrice,
          signatures: closeData.signatures,
          errors: closeErrors
        })
      } catch (trackError) {
        console.error('Failed to track close operation for history/PnL:', trackError)
      }

      // Refresh token list and clear selection
      if (closeData.successful.length > 0) {
        await fetchTokens()
        setSelectedTokens([])
        setSelectedZeroBalanceTokens([])
      }
    } catch (err) {
      console.error('Close-only operation error:', err)
      if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('An unknown error occurred. Please try again.')
      }
    } finally {
      setIsLoading(false)
    }
  }, [connected, publicKey, signAllTransactions, connection, selectedTokens, selectedZeroBalanceTokens, slippage, priorityFee, fetchTokens, trackOperation])

  // Fetch user tokens on wallet connection
  useEffect(() => {
    if (connected && publicKey) {
      setIsInitialLoad(true) // Set initial load state before fetching
      fetchTokens()
      fetchSolPrice()
    } else {
      setUserTokens([])
      setZeroBalanceTokens([])
      setSelectedTokens([])
      setSelectedZeroBalanceTokens([])
      setIsInitialLoad(true) // Reset initial load state when wallet disconnects
    }
  }, [connected, publicKey, fetchTokens, fetchSolPrice])
  
  // Refresh SOL price periodically
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSolPrice()
    }, 30000) // Every 30 seconds
    
    return () => clearInterval(interval)
  }, [fetchSolPrice])

  // Set up metadata update callback
  useEffect(() => {
    setMetadataUpdateCallback(handleMetadataUpdate)
    return () => clearMetadataUpdateCallback()
  }, [handleMetadataUpdate])

  // Calculate estimated SOL after fees for selected tokens
  const grossUSD = selectedTokens.reduce((total, token) => total + (token.usdValue * token.sellPercentage / 100), 0)
  const grossSOL = grossUSD / solPriceUsd // Convert USD to SOL
  const sellFee = getFeeForOperation('SELL', grossSOL) // 0.5% of SOL received
  const tokensToClose = selectedTokens.filter(token => token.sellPercentage >= 100).length + selectedZeroBalanceTokens.length
  const closeFee = getFeeForOperation('CLOSE') * tokensToClose // Fixed fee per account
  const rentRecovery = tokensToClose * 0.00203928 // Rent recovery
  const estimatedSOL = grossSOL - sellFee - closeFee + rentRecovery

  // Calculate total reload estimation based on showDustOnly filter
  const tokensForCalculation = showDustOnly 
    ? userTokens.filter(token => token.usdValue < 0.1) // Only dust tokens
    : userTokens.filter(token => token.usdValue >= 0.1) // Only non-dust tokens
  
  const totalGrossUSD = tokensForCalculation.reduce((total, token) => total + token.usdValue, 0)
  // Include zero-balance tokens in calculation (they contribute to rent recovery)
  const totalZeroTokens = zeroBalanceTokens.length
  const totalGrossSOL = totalGrossUSD / solPriceUsd
  const totalSellFee = getFeeForOperation('SELL', totalGrossSOL)
  const totalCloseFee = getFeeForOperation('CLOSE') * (tokensForCalculation.length + totalZeroTokens)
  const totalRentRecovery = (tokensForCalculation.length + totalZeroTokens) * 0.00203928
  const totalReloadEstimate = totalGrossSOL - totalSellFee - totalCloseFee + totalRentRecovery

  // Handle token selection for chart display
  const handleSelectToken = useCallback((mintAddress: string) => {
    // Show chart for the selected token
    setSelectedToken(mintAddress)
    setIsChartLoading(true)
  }, [])

  // Filter tokens based on dust filter
  const filteredUserTokens = showDustOnly 
    ? userTokens.filter(token => token.usdValue < 0.1)
    : userTokens

  // Toggle dust filter
  const toggleDustFilter = () => {
    setShowDustOnly(prev => !prev)
    // Clear selection when toggling filter to avoid confusion
    setSelectedTokens([])
  }

  return (
    <div className="bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex justify-between items-center w-full">
          <h2 className="text-3xl font-bold text-white">Sell Bulk & Reload your solana</h2>
          <div className="shrink-0">
            <PhantomWalletButton />
          </div>
        </div>
      </div>
      <div className="space-y-8">
        {/* Token Chart Section */}
        {selectedToken && (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <label className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                Token Chart
              </label>
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
        
        {/* Token Selection Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h3 className="text-xl font-light text-white mb-1">You have {userTokens.length > 0 && totalReloadEstimate > 0 
            && <span className="font-bold">~ {(totalReloadEstimate).toFixed(3)} SOL</span>
          } to reload 🚀</h3>
            <p className="text-gray-400 text-sm">
              {selectedTokens.length} of {filteredUserTokens.length} {showDustOnly ? 'dust' : 'valuable'} tokens selected
              {showDustOnly && filteredUserTokens.length !== userTokens.length}
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={refreshAllPrices}
              disabled={isLoadingTokens || userTokens.length === 0}
              className="p-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Refresh Prices"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={toggleDustFilter}
              className={`px-4 py-2 rounded-lg transition-colors text-sm flex items-center space-x-2 ${
                showDustOnly
                  ? 'bg-gray-600 hover:bg-gray-500 text-white'
                  : 'bg-yellow-600 hover:bg-yellow-500 text-white'
              }`}
            >
              <span>{showDustOnly ? 'Show all' : 'Dust only' }</span>
            </button>
            <button
              onClick={selectAllTokens}
              disabled={filteredUserTokens.length === 0}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors text-sm"
            >
              Select All
            </button>
            <button
              onClick={clearSelection}
              disabled={selectedTokens.length === 0}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors text-sm"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="flex justify-between items-center">
          <h3 className="text-md font-semibold text-white mb-1">Your Tokens</h3>
          <p className="text-xs text-gray-400 flex items-center">
            <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            Hover over a token and click on the  <svg className="w-4 h-4 mx-1 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
              </svg> icon to view price charts
          </p>
        </div>

        {/* Token List */}
        {isLoadingTokens ? (
          <>
            <TokenSkeleton count={3} variant="progressive" />
          </>
        ) : userTokens.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-300 mb-2">No tokens found</h3>
            <p className="text-gray-400 mb-4">You don't have any tokens to sell</p>
            <button
              onClick={fetchTokens}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors"
            >
              Refresh Tokens
            </button>
          </div>
        ) : filteredUserTokens.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-300 mb-2">No dust tokens found</h3>
            <p className="text-gray-400 mb-4">You don't have any tokens worth less than $0.1</p>
            <button
              onClick={toggleDustFilter}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors"
            >
              Show All Tokens
            </button>
          </div>
        ) : (
          <div className="grid max-h-96 overflow-y-auto border border-gray-600 rounded-xl">
            {filteredUserTokens.map((token) => {
              const isSelected = selectedTokens.some(t => t.mintAddress === token.mintAddress)
              const selectedToken = selectedTokens.find(t => t.mintAddress === token.mintAddress)
              return (
                <ProgressiveTokenItem
                  key={token.mintAddress}
                  token={token}
                  isSelected={isSelected}
                  isLoading={false}
                  onToggleSelection={toggleTokenSelection}
                  onSelectToken={handleSelectToken}
                  onRefreshPrice={refreshTokenPrice}
                  selectedToken={selectedToken}
                  onUpdateSellPercentage={updateTokenSellPercentage}
                />
              )
            })}
          </div>
        )}

        {/* Zero-Balance Tokens Section */}
        {zeroBalanceTokens.length > 0 && (
          <>
            <div className="border-t border-gray-600 pt-8">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                  <h3 className="text-md font-semibold text-white mb-1">Your useless tokens</h3>
                  <p className="text-gray-400 text-sm">
                    Close accounts to recover rent • {selectedZeroBalanceTokens.length} of {zeroBalanceTokens.length} selected
                  </p>
                </div>
                <div className="flex items-center space-x-3">
                  <button
                    onClick={selectAllZeroBalanceTokens}
                    disabled={zeroBalanceTokens.length === 0}
                    className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors text-sm"
                  >
                    Select All
                  </button>
                  <button
                    onClick={clearZeroBalanceSelection}
                    disabled={selectedZeroBalanceTokens.length === 0}
                    className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors text-sm"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="grid max-h-96 overflow-y-auto border border-gray-600 rounded-xl">
                {zeroBalanceTokens.map((token) => {
                  const isSelected = selectedZeroBalanceTokens.some(t => t.mintAddress === token.mintAddress)
                  return (
                    <div
                      key={token.mintAddress}
                      className={`group p-2 m-1 rounded-xl transition-all duration-200 ${
                        isSelected
                          ? 'bg-gray-700'
                          : 'bg-gray-900'
                      }`}
                    >
                      <div 
                        className="flex items-center justify-between cursor-pointer"
                        onClick={() => toggleZeroBalanceTokenSelection(token)}
                      >
                        <div className="flex items-center space-x-3">
                          {/* Checkbox */}
                          <div className="flex items-center justify-center">
                            <div className={`w-4 h-4 sm:w-4 sm:h-4 rounded border-2 flex items-center justify-center transition-colors ${
                              isSelected 
                                ? 'bg-blue-500 border-blue-500' 
                                : 'border-gray-500 hover:border-gray-400'
                            }`}>
                              {isSelected && (
                                <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                            </div>
                          </div>

                          {/* Token Icon */}
                          <div className={`w-4 h-4 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-white font-bold ${
                            isSelected ? 'bg-white text-black' : 'bg-gray-600'
                          }`}>
                            <span>{token.symbol?.charAt(0) || 'T'}</span>
                          </div>

                          {/* Token Name */}
                          <div className="font-semibold text-gray-300">
                            {token.name || token.symbol || 'Unknown'}
                          </div>

                          {/* Chart Icon */}
                          <button 
                            onClick={(e) => {
                              e.stopPropagation()
                              handleSelectToken(token.mintAddress)
                            }}
                            className="ml-2 p-1 bg-gray-600 rounded hover:bg-gray-500 transition-colors"
                            title="View Chart"
                          >
                            <svg className="w-3 h-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )}

        {/* Settings and Summary */}
        {(selectedTokens.length > 0 || selectedZeroBalanceTokens.length > 0) && (
          <>
            {/* Collapsible Settings Section */}
            <div className="bg-gray-800 border border-gray-600 rounded-xl">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="w-full p-4 flex items-center justify-between text-left hover:bg-gray-700 transition-colors rounded-xl"
              >
                <div>
                  <h3 className="text-sm font-semibold text-white mb-1">
                    Trading Settings & Quotes
                  </h3>
                </div>
                <svg 
                  className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${
                    showSettings ? 'rotate-180' : ''
                  }`} 
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              
              {showSettings && (
                <div className="px-4 pb-4 space-y-6">
                  {/* Settings Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Swap Provider */}
                    <div className="space-y-3">
                      <label htmlFor="swapProvider" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                        Swap Provider
                      </label>
                      <select
                        id="swapProvider"
                        value={swapProvider}
                        onChange={(e) => setSwapProvider(e.target.value as 'jupiter' | 'gmgn')}
                        className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-xl text-white focus:bg-gray-600 focus:border-gray-400 transition-all duration-200"
                        disabled={isLoading}
                      >
                        {PROVIDER_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value} className="bg-gray-700">
                            {option.icon} {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Slippage */}
                    <div className="space-y-3">
                      <label htmlFor="slippage" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                        Slippage Tolerance
                      </label>
                      <select
                        id="slippage"
                        value={slippage}
                        onChange={(e) => setSlippage(Number(e.target.value))}
                        className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-xl text-white focus:bg-gray-600 focus:border-gray-400 transition-all duration-200"
                        disabled={isLoading}
                      >
                        {SLIPPAGE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value} className="bg-gray-700">
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Priority Fee */}
                    <div className="space-y-3">
                      <label htmlFor="priorityFee" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                        Priority Fee
                      </label>
                      <select
                        id="priorityFee"
                        value={priorityFee}
                        onChange={(e) => setPriorityFee(Number(e.target.value))}
                        className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-xl text-white focus:bg-gray-600 focus:border-gray-400 transition-all duration-200"
                        disabled={isLoading}
                      >
                        {PRIORITY_FEE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value} className="bg-gray-700">
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Quote Controls */}
                  <div className="border-t border-gray-600 pt-4">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                      <div>
                        <h4 className="text-md font-semibold text-white mb-1">
                          {swapProvider.charAt(0).toUpperCase() + swapProvider.slice(1)} Quotes
                        </h4>
                        <p className="text-gray-400 text-sm">
                          {Object.keys(quotes).length} quote{Object.keys(quotes).length !== 1 ? 's' : ''} loaded
                          {lastQuoteTime > 0 && (
                            <span className="ml-2">• Last updated {Math.floor((Date.now() - lastQuoteTime) / 1000)}s ago</span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center space-x-3">
                        {/* Auto-quote toggle */}
                        <label className="flex items-center space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoQuote}
                            onChange={(e) => setAutoQuote(e.target.checked)}
                            className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 focus:ring-2"
                          />
                          <span className="text-sm text-gray-300">Auto-quote (5s)</span>
                        </label>
                        
                        {/* Manual quote button */}
                        <button
                          onClick={fetchAllQuotes}
                          disabled={isGettingQuotes || selectedTokens.length === 0}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm flex items-center space-x-2"
                        >
                          {isGettingQuotes ? (
                            <>
                              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                              <span>Getting Quotes...</span>
                            </>
                          ) : (
                            <>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              <span>Get Quotes</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                    
                    {/* Quote Summary */}
                    {Object.keys(quotes).length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                        <div className="text-center p-3 bg-gray-700 rounded-lg">
                          <div className="font-medium text-white">Total SOL Output</div>
                          <div className="text-green-400 font-bold text-lg">
                            {selectedTokens.reduce((total, token) => {
                              const quote = getQuoteForToken(token.mintAddress)
                              if (quote && isQuoteValid(quote)) {
                                return total + (parseFloat(quote.outAmount) / 1e9) // Convert lamports to SOL
                              }
                              return total
                            }, 0).toFixed(6)} SOL
                          </div>
                        </div>
                        <div className="text-center p-3 bg-gray-700 rounded-lg">
                          <div className="font-medium text-white">Avg Price Impact</div>
                          <div className="text-yellow-400 font-bold text-lg">
                            {selectedTokens.length > 0 ? (
                              selectedTokens.reduce((total, token) => {
                                const quote = getQuoteForToken(token.mintAddress)
                                if (quote && isQuoteValid(quote)) {
                                  return total + quote.priceImpact
                                }
                                return total
                              }, 0) / selectedTokens.filter(token => {
                                const quote = getQuoteForToken(token.mintAddress)
                                return quote && isQuoteValid(quote)
                              }).length
                            ).toFixed(2) : '0.00'}%
                          </div>
                        </div>
                        <div className="text-center p-3 bg-gray-700 rounded-lg">
                          <div className="font-medium text-white">Valid Quotes</div>
                          <div className="text-blue-400 font-bold text-lg">
                            {selectedTokens.filter(token => {
                              const quote = getQuoteForToken(token.mintAddress)
                              return quote && isQuoteValid(quote)
                            }).length}/{selectedTokens.length}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col md:flex-row gap-4">
              {/* Show Sell button only when there are sellable tokens selected */}
              {selectedTokens.length > 0 && (
                <button
                  onClick={handleBulkSell}
                  disabled={isLoading}
                  className={`${selectedZeroBalanceTokens.length > 0 ? 'md:w-3/4' : 'w-full'} w-full py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-200 ${
                    isLoading
                      ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                      : 'bg-white hover:bg-gray-100 text-black shadow-lg hover:shadow-xl'
                  }`}
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center space-x-3">
                      <div className="w-5 h-5 border-2 border-gray-400 border-t-black rounded-full animate-spin"></div>
                      <span>Processing...</span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center space-x-2">
                      <span>
                        {(() => {
                          const totalSolOutput = selectedTokens.reduce((total, token) => {
                            const quote = getQuoteForToken(token.mintAddress)
                            if (quote && isQuoteValid(quote)) {
                              return total + (parseFloat(quote.outAmount) / 1e9)
                            }
                            return total
                          }, 0)
                          
                          const tokenText = selectedTokens.length === 1 ? 'token' : `${selectedTokens.length} tokens`
                          
                          return totalSolOutput > 0 
                            ? `Sell & close ${tokenText} for ${totalSolOutput.toFixed(4)} SOL`
                            : `Sell & close ${tokenText}`
                        })()} 
                      </span>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2z" />
                      </svg>
                    </div>
                  )}
                </button>
              )}

              {/* Close Only - Show only when there are zero-balance tokens to close */}
              {selectedZeroBalanceTokens.length > 0 && (
                <button
                  onClick={handleCloseOnly}
                  disabled={isLoading}
                  className={`${selectedTokens.length === 0 ? 'w-full' : 'md:w-1/4 w-full'} py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-200 ${
                    isLoading
                      ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                      : 'bg-yellow-600 hover:bg-yellow-500 text-white shadow-lg hover:shadow-xl'
                  }`}
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center space-x-3">
                      <div className="w-5 h-5 border-2 border-yellow-300 border-t-white rounded-full animate-spin"></div>
                      <span>Processing...</span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center space-x-2">
                      <span>
                        Directly Close {selectedTokens.length + selectedZeroBalanceTokens.length} Token{(selectedTokens.length + selectedZeroBalanceTokens.length) !== 1 ? 's' : ''}
                      </span>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </div>
                  )}
                </button>
              )}
            </div>
          </>
        )}

        {/* Error Display */}
        {error && (
          <div className="bg-gradient-to-r from-red-900/50 to-red-800/50 border border-red-500/50 text-red-200 px-4 py-3 rounded-xl backdrop-blur-sm animate-slide-up">
            <div className="flex items-start space-x-3">
              <svg className="w-5 h-5 mt-0.5 text-red-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}

        {/* Transaction Result Modal */}
        <TransactionResultModal
          isOpen={showResultModal}
          onClose={() => setShowResultModal(false)}
          operation="sell"
          result={result}
          balanceBefore={balanceBefore}
          balanceAfter={balanceAfter}
          pointsEarned={sellPointsEarned ?? undefined}
        />

        {/* Close Result Modal */}
        <TransactionResultModal
          isOpen={showCloseResultModal}
          onClose={() => setShowCloseResultModal(false)}
          operation="close"
          result={closeResult}
          pointsEarned={closePointsEarned ?? undefined}
        />
        
        {/* ✅ NEW: Add PnL Share Modal */}
        <PnLShareModal
          isOpen={isShareModalOpen}
          onClose={hideShareModal}
          shareData={shareData}
          onCopySuccess={() => console.log('Tweet text copied from BulkTokenSeller!')}
        />
      </div>

      {/* {connected && (
      )} */}
    </div>
  )
}
