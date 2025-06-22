'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { useWallet, useConnection } from '../components/WalletProvider'
import PhantomWalletButton from './PhantomWalletButton'
import TransactionResultModal from './TransactionResultModal'
import TokenSkeleton from './TokenSkeleton'
import ProgressiveTokenItem from './ProgressiveTokenItem'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { 
  executeBulkSell, 
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
import { trackSellOperation, trackCloseOperation } from '@/utils/trading-tracker'
import { SLIPPAGE_OPTIONS, PRIORITY_FEE_OPTIONS } from '@/utils/solana'
import { trackSell, trackClose } from '@/utils/operations-api'

// SOL mint address for Jupiter API v2
const SOL_MINT = 'So11111111111111111111111111111111111111112'

export default function BulkTokenSeller() {
  const { publicKey, signAllTransactions, connected } = useWallet()
  const { connection } = useConnection()
  
  // Form state - Updated to use TokenToSell
  const [selectedTokens, setSelectedTokens] = useState<TokenToSell[]>([])
  const [selectedZeroBalanceTokens, setSelectedZeroBalanceTokens] = useState<UserToken[]>([])
  const [slippage, setSlippage] = useState<number>(100) // 1%
  const [priorityFee, setPriorityFee] = useState<number>(100000) // 0.0001 SOL
  
  // UI state
  const [userTokens, setUserTokens] = useState<UserToken[]>([])
  const [zeroBalanceTokens, setZeroBalanceTokens] = useState<UserToken[]>([])
  const [isLoadingTokens, setIsLoadingTokens] = useState<boolean>(false)
  const [isInitialLoad, setIsInitialLoad] = useState<boolean>(true)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [isClosingAccounts, setIsClosingAccounts] = useState<boolean>(false)
  const [result, setResult] = useState<BulkSellResult | null>(null)
  const [closeResult, setCloseResult] = useState<{ successful: string[]; failed: Array<{ mintAddress: string; error: string }>; signatures: string[] } | null>(null)
  const [error, setError] = useState<string>('')
  const [showResultModal, setShowResultModal] = useState<boolean>(false)
  const [showCloseResultModal, setShowCloseResultModal] = useState<boolean>(false)
  const [selectedToken, setSelectedToken] = useState<string>('')
  const [isChartLoading, setIsChartLoading] = useState<boolean>(false)
  const [showDustOnly, setShowDustOnly] = useState<boolean>(false)
  
  // Balance tracking
  const [balanceBefore, setBalanceBefore] = useState<number>(0)
  const [balanceAfter, setBalanceAfter] = useState<number>(0)
  
  // SOL price in USD
  const [solPriceUsd, setSolPriceUsd] = useState<number>(145) // Default fallback

  const feeRates = getAllFeeRates()

  // Fetch SOL price from Jupiter API v2
  const fetchSolPrice = useCallback(async () => {
    try {
      const response = await fetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`)
      if (!response.ok) {
        throw new Error(`Jupiter API responded with status: ${response.status}`)
      }
      const data = await response.json()
      if (data?.data?.[SOL_MINT]?.price) {
        const price = parseFloat(data.data[SOL_MINT].price)
        setSolPriceUsd(price)
        console.log(`SOL price updated: $${price}`)
      }
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
    if (!publicKey || userTokens.length === 0) return
    
    // Set loading state for all tokens
    setUserTokens(prev => prev.map(token => ({ ...token, isLoadingPrice: true })))
    
    try {
      console.log('Starting efficient batch price refresh...')
      
      // Use efficient batch price refresh
      const updatedTokens = await refreshTokenPricesBatch(userTokens)
        
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
  }, [publicKey, userTokens])

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

      const sellResult = await executeBulkSell(
        request,
        publicKey.toString(),
        connection,
        signAllTransactions
      )

      // Get balance after operation
      const balanceAfterOp = await connection.getBalance(publicKey)
      const balanceAfterSOL = balanceAfterOp / LAMPORTS_PER_SOL
      setBalanceAfter(balanceAfterSOL)

      setResult(sellResult)
      setShowResultModal(true)

      // Track the sell operation
      if (sellResult) {
        // Track sell operations (swaps)
        if (sellResult.successfulSwaps.length > 0 || sellResult.failedSwaps.length > 0) {
          const sellTokenData = selectedTokens.map(token => ({
            mintAddress: token.mintAddress,
            symbol: token.symbol,
            name: token.name,
            logoURI: token.logoURI
          }))

          const sellErrors = sellResult.failedSwaps.length > 0 
            ? sellResult.failedSwaps.map(f => f.error)
            : undefined

          // Track sell operation securely via server route
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

            // Also track locally for TradingHistory component
            trackSellOperation(
              publicKey.toString(),
              sellTokenData,
              sellResult.totalReceived || 0,
              sellResult.successfulSwaps.length,
              sellResult.failedSwaps.length,
              sellResult.signatures,
              0, // feesPaid - we don't track this locally yet
              slippage / 100,
              priorityFee,
              sellErrors
            );
          } catch (trackError) {
            console.error('Failed to track sell operation:', trackError);
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

          const closeTokenData = allClosedTokens.map(token => ({
            mintAddress: token.mintAddress,
            symbol: token.symbol,
            name: token.name,
            logoURI: token.logoURI
          }))

          const closeErrors = sellResult.failedCloses.length > 0 
            ? sellResult.failedCloses.map(f => f.error)
            : undefined

          // Track close operation securely via server route
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

            // Also track locally for TradingHistory component
            trackCloseOperation(
              publicKey.toString(),
              closeTokenData,
              sellResult.successfulCloses.length,
              sellResult.failedCloses.length,
              sellResult.signatures,
              0, // feesPaid - we don't track this locally yet
              closeErrors
            );
          } catch (trackError) {
            console.error('Failed to track close operation:', trackError);
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
  }, [connected, publicKey, signAllTransactions, connection, selectedTokens, selectedZeroBalanceTokens, slippage, priorityFee, fetchTokens])

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

  // Calculate estimated SOL after fees
  const grossUSD = selectedTokens.reduce((total, token) => total + (token.usdValue * token.sellPercentage / 100), 0)
  const grossSOL = grossUSD / solPriceUsd // Convert USD to SOL
  const sellFee = getFeeForOperation('SELL', grossSOL) // 0.5% of SOL received
  const tokensToClose = selectedTokens.filter(token => token.sellPercentage >= 100).length + selectedZeroBalanceTokens.length
  const closeFee = getFeeForOperation('CLOSE') * tokensToClose // Fixed fee per account
  const rentRecovery = tokensToClose * 0.00203928 // Rent recovery
  const estimatedSOL = grossSOL - sellFee - closeFee + rentRecovery

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
        <div>
          <h2 className="text-3xl font-bold text-white mb-2">Bulk Sell & Reload your SOL</h2>
          <p className="text-gray-400">Sell your tokens - automatically close accounts & reload your SOL</p>
        </div>
        <div className="shrink-0">
          <PhantomWalletButton />
        </div>
      </div>

      {connected && (
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
                    <div className="w-10 h-10 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
                  </div>
                )}
                <iframe 
                  src={`https://birdeye.so/tv-widget/${selectedToken}?chain=solana&viewMode=pair&chartInterval=1D&chartType=CANDLE&chartTimezone=Asia%2FSingapore&chartLeftToolbar=show&theme=dark`}
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
              <h3 className="text-xl font-semibold text-white mb-1">Your Tokens</h3>
              <p className="text-gray-400 text-sm">
                Select tokens to sell • {selectedTokens.length} of {showDustOnly ? `${filteredUserTokens.length} dust` : filteredUserTokens.length} selected
                {showDustOnly && filteredUserTokens.length !== userTokens.length && (
                  <span className="text-gray-500"> ({userTokens.length} total)</span>
                )}
              </p>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={toggleDustFilter}
                className={`px-4 py-2 rounded-lg transition-colors text-sm flex items-center space-x-2 ${
                  showDustOnly
                    ? 'bg-yellow-600 hover:bg-yellow-500 text-white'
                    : 'bg-gray-600 hover:bg-gray-500 text-white'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                <span>{showDustOnly ? 'Show All' : 'Dust < $0.1'}</span>
              </button>
              <button
                onClick={fetchTokens}
                disabled={isLoadingTokens}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors text-sm"
              >
                {isLoadingTokens ? 'Refreshing...' : 'Refresh'}
              </button>
              <button
                onClick={refreshAllPrices}
                disabled={isLoadingTokens || userTokens.length === 0}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors text-sm"
              >
                Refresh Prices
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
            <div className="grid gap-3 max-h-96 overflow-y-auto">
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
                    <h3 className="text-xl font-semibold text-white mb-1">Unsellable Tokens</h3>
                    <p className="text-gray-400 text-sm">
                      Zero balance or no liquidity • Close accounts to recover rent • {selectedZeroBalanceTokens.length} of {zeroBalanceTokens.length} selected
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

                <div className="grid gap-3 max-h-64 overflow-y-auto">
                  {zeroBalanceTokens.map((token) => {
                    const isSelected = selectedZeroBalanceTokens.some(t => t.mintAddress === token.mintAddress)
                    return (
                      <div
                        key={token.mintAddress}
                        onClick={() => toggleZeroBalanceTokenSelection(token)}
                        className={`group p-4 rounded-xl border cursor-pointer transition-all duration-200 ${
                          isSelected
                            ? 'bg-gray-700 border-gray-500'
                            : 'bg-gray-800 border-gray-600 hover:bg-gray-700 hover:border-gray-500'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-3">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold ${
                              isSelected ? 'bg-white text-black' : 'bg-gray-600'
                            }`}>
                              {token.symbol?.charAt(0) || 'T'}
                            </div>
                            <div>
                              <div className="font-semibold text-white">
                                {token.name || token.symbol || 'Unknown'}
                              </div>
                              <div className="text-sm text-gray-400">
                                {token.symbol && token.name !== token.symbol ? token.symbol : ''}
                              </div>
                              <div className="text-xs text-gray-400 font-mono truncate max-w-48">
                                {token.mintAddress}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-semibold text-gray-400">
                              {token.uiAmount > 0.000001 
                                ? `${token.uiAmount.toFixed(6)} tokens`
                                : '0 tokens'
                              }
                            </div>
                            <div className="text-sm text-gray-400">
                              {token.uiAmount > 0.000000000001 
                                ? (token.usdValue > 0 ? `≈ $${token.usdValue.toFixed(2)} (< $0.001)` : 'No liquidity')
                                : 'Close for rent'
                              }
                            </div>
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
              {/* Summary */}
              <div className="bg-gray-800 border border-gray-600 rounded-xl p-6">
                <h4 className="font-semibold text-white mb-4">Operation Summary</h4>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="block text-gray-300 font-medium">Total Operations</span>
                    <span className="text-xl font-bold text-white">{selectedTokens.length} Swap & {tokensToClose} Close</span>
                  </div>
                  <div>
                    <span className="block text-gray-300 font-medium">You'll receive</span>
                    <span className="text-xl font-bold text-white">~ {estimatedSOL.toFixed(4)} SOL</span>
                    <span className="block text-gray-400 text-sm">≈ ${(estimatedSOL * solPriceUsd).toFixed(2)}</span>
                    <span className="block text-gray-500 text-xs mt-1">
                          After fees & with rent recovery
                    </span>
                  </div>
                </div>
                
                {selectedZeroBalanceTokens.length > 0 && (
                  <div className="mt-4 p-3 bg-gray-700 border border-gray-600 rounded-lg">
                    <p className="text-gray-200 text-sm">
                      <strong>{selectedZeroBalanceTokens.length} unsellable token{selectedZeroBalanceTokens.length !== 1 ? 's' : ''}</strong> will be burned (if needed) and closed to recover rent
                    </p>
                  </div>
                )}
                
                {selectedTokens.some(token => token.sellPercentage < 100) && (
                  <div className="mt-4 p-3 bg-blue-700 border border-blue-600 rounded-lg">
                    <p className="text-blue-200 text-sm">
                      <strong>{selectedTokens.filter(token => token.sellPercentage < 100).length} token{selectedTokens.filter(token => token.sellPercentage < 100).length !== 1 ? 's' : ''}</strong> will be partially sold (accounts remain open)
                    </p>
                  </div>
                )}
              </div>

              {/* Settings Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Slippage */}
                <div className="space-y-3">
                  <label htmlFor="slippage" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                    Slippage Tolerance
                  </label>
                  <select
                    id="slippage"
                    value={slippage}
                    onChange={(e) => setSlippage(Number(e.target.value))}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
                    disabled={isLoading}
                  >
                    {SLIPPAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-gray-800">
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
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl text-white focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
                    disabled={isLoading}
                  >
                    {PRIORITY_FEE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-gray-800">
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Sell Button */}
              <button
                onClick={handleBulkSell}
                disabled={isLoading || (selectedTokens.length === 0 && selectedZeroBalanceTokens.length === 0)}
                className={`w-full py-4 px-6 rounded-xl font-semibold text-lg transition-all duration-200 ${
                  isLoading || (selectedTokens.length === 0 && selectedZeroBalanceTokens.length === 0)
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
                      {selectedTokens.length > 0 && selectedZeroBalanceTokens.length > 0
                        ? `Sell ${selectedTokens.length} & Close ${tokensToClose} Accounts`
                        : selectedTokens.length > 0
                        ? `Sell ${selectedTokens.length} Token${selectedTokens.length !== 1 ? 's' : ''} ${tokensToClose > 0 ? `& Close ${tokensToClose}` : ''}`
                        : `Close ${selectedZeroBalanceTokens.length} Account${selectedZeroBalanceTokens.length !== 1 ? 's' : ''}`
                      }
                    </span>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2z" />
                    </svg>
                  </div>
                )}
              </button>
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
          />

          {/* Close Result Modal */}
          <TransactionResultModal
            isOpen={showCloseResultModal}
            onClose={() => setShowCloseResultModal(false)}
            operation="close"
            result={closeResult}
          />
        </div>
      )}

      {!connected && (
        <div className="text-center py-12">
          <div className="bg-gradient-to-br from-slate-700/30 to-slate-800/30 border border-slate-600/50 rounded-2xl p-8 backdrop-blur-sm">
            <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-red-500 to-orange-600 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2z" />
              </svg>
            </div>
            {/* <h3 className="text-xl font-semibold text-white mb-2">Connect Your Wallet</h3> */}
            <p className="text-slate-400 mb-6 max-w-md mx-auto">
              Sell any token with automatic account closing  <br />
              and Reload your Solana
            </p>
            <PhantomWalletButton />
          </div>
        </div>
      )}
    </div>
  )
} 
