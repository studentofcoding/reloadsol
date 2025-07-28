'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useWallet, useConnection } from '@/components/WalletProvider'
import WalletSwitcher from '@/components/WalletSwitcher'
import TrendingTokens from './TrendingTokens'
import TransactionResultModal from './TransactionResultModal'
import TokenSkeleton from './TokenSkeleton'
import RiskAnalysis from './RiskAnalysis'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { executeBulkBuy, parseMintAddresses, isValidMintAddress, getAllFeeRates, fetchUserTokensEfficient, setMetadataUpdateCallback, clearMetadataUpdateCallback, UserToken } from '@/utils/jupiter'
import { SLIPPAGE_OPTIONS, PRIORITY_FEE_OPTIONS, getSolPriceUSD } from '@/utils/solana'
import { BulkBuyRequest, BulkBuyResult } from '@/types'
import { trackBuy } from '@/utils/operations-api'
import { useTradingData } from './TradingDataProvider'
import { connection } from '../utils/connection'
import { fetchAxiomTokenInfo, getRiskIndicators, formatRiskDisplay, calculateFeeToMarketCapRatio } from '@/utils/axiom'

export default function BulkTokenBuyer() {
  const { publicKey, signAllTransactions, connected } = useWallet()
  const { connection } = useConnection()
  const { trackOperation } = useTradingData()
  const searchParams = useSearchParams()
  
  // Form state
  const [solAmount, setSolAmount] = useState<string>('0.1')
  const [tokenMints, setTokenMints] = useState<string>('')
  const [slippage, setSlippage] = useState<number>(200) // 1%
  const [priorityFee, setPriorityFee] = useState<number>(30000) // 0.0003 SOL
  
  // URL parameter initialization state
  const [initialized, setInitialized] = useState<boolean>(false)
  
  // Token metadata state
  type TokenInfo = {
    address: string;
    name: string;
    symbol: string;
    icon?: string;
    mcap?: number;
  }
  const [tokenList, setTokenList] = useState<TokenInfo[]>([])
  
  // UI state
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [isLoadingMetadata, setIsLoadingMetadata] = useState<boolean>(false)
  const [result, setResult] = useState<BulkBuyResult | null>(null)
  const [pointsEarned, setPointsEarned] = useState<number | null>(null)
  const [error, setError] = useState<string>('')
  const [showResultModal, setShowResultModal] = useState<boolean>(false)
  const [selectedToken, setSelectedToken] = useState<string>('')
  const [selectedTokenInfo, setSelectedTokenInfo] = useState<TokenInfo | null>(null)
  const [isChartLoading, setIsChartLoading] = useState<boolean>(false)
  
  // Duplicate auto-select effect removed (see later effect after validMints declaration)

  // Balance tracking
  const [balanceBefore, setBalanceBefore] = useState<number>(0)
  const [balanceAfter, setBalanceAfter] = useState<number>(0)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)

  // User's current token holdings for search
  const [userTokens, setUserTokens] = useState<UserToken[]>([])
  const [isLoadingUserTokens, setIsLoadingUserTokens] = useState<boolean>(false)

  // Token search state
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const searchTimeout = useRef<NodeJS.Timeout | null>(null)
  const searchBoxRef = useRef<HTMLDivElement>(null)

  // Risk analysis state
  const [axiomData, setAxiomData] = useState<Map<string, { data: any; risk: any; pairNotFound?: boolean }>>(new Map())
  const [loadingAxiom, setLoadingAxiom] = useState<Set<string>>(new Set())
  const [showRiskAnalysis, setShowRiskAnalysis] = useState<boolean>(false)

  // Parse and validate mint addresses
  const parsedMints = parseMintAddresses(tokenMints)
  const validMints = parsedMints.filter(isValidMintAddress)

  // Auto-select first mint from URL params (display chart automatically)
  useEffect(() => {
    if (initialized && validMints.length > 0 && !selectedToken) {
      handleSelectToken(validMints[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, validMints])

  // Initialize from URL parameters (run once)
  useEffect(() => {
    if (initialized) return

    const sol = searchParams.get('sol')
    const mints = searchParams.get('mints')

    if (sol && !Number.isNaN(+sol) && +sol > 0) {
      setSolAmount(sol)
    }

    if (mints) {
      const tokenStr = mints
        .split(',')
        .slice(0, 10)              // enforce limit
        .filter(Boolean)           // remove empty strings
        .join('\n')
      setTokenMints(tokenStr)
    }

    setInitialized(true)
  }, [initialized, searchParams])
  
  // When tokenMints changes, update tokenList
  useEffect(() => {
    const fetchTokenMetadata = async (addresses: string[]) => {
      // Filter for addresses we don't have metadata for yet
      const existingAddresses = new Set(tokenList.map(token => token.address))
      const addressesToFetch = addresses.filter(addr => !existingAddresses.has(addr) && isValidMintAddress(addr))
      
      if (addressesToFetch.length === 0) return
      
      setIsLoadingMetadata(true)
      
      // Create promises for each address
      const fetchPromises = addressesToFetch.map(async (address): Promise<TokenInfo | null> => {
        try {
          const res = await fetch(`/api/trending/search?query=${address}`)
          if (!res.ok) return null
          
          const data = await res.json()
          const tokenInfo = Array.isArray(data) ? data.find(t => t.id === address) : null
          
          if (tokenInfo) {
            return {
              address,
              name: tokenInfo.name || 'Unknown Token',
              symbol: tokenInfo.symbol || '???',
              icon: tokenInfo.icon || undefined,
              mcap: tokenInfo.mcap || 0
            }
          } else {
            return {
              address,
              name: 'Unknown Token',
              symbol: address.substring(0, 4) + '...',
              icon: undefined,
              mcap: 0
            }
          }
        } catch {
          return {
            address,
            name: 'Unknown Token',
            symbol: address.substring(0, 4) + '...',
            icon: undefined,
            mcap: 0
          }
        }
      })
      
      // Execute all fetches in parallel
      const results = await Promise.all(fetchPromises)
      const validResults = results.filter((result): result is TokenInfo => result !== null)
      
      if (validResults.length > 0) {
        setTokenList(currentList => [...currentList, ...validResults])
      }
      
      setIsLoadingMetadata(false)
    }
    
    // Only update if there are valid mints that might not be in the list
    if (validMints.length > 0) {
      fetchTokenMetadata(validMints)
    } else {
      setIsLoadingMetadata(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenMints])
  
  // Handle adding a token to the list
  const handleAddToken = useCallback((mintAddress: string) => {
    // Check if the mint address is already in the list
    if (!parsedMints.includes(mintAddress)) {
      // Add the new mint address to the existing ones
      const newTokenMints = tokenMints 
        ? tokenMints.trim() + '\n' + mintAddress 
        : mintAddress
      setTokenMints(newTokenMints)
    }
  }, [tokenMints, parsedMints])
  
  // Handle removing a token
  const handleRemoveToken = (addressToRemove: string) => {
    // Remove from parsed mints and update tokenMints string
    const updatedMints = parsedMints.filter(addr => addr !== addressToRemove)
    setTokenMints(updatedMints.join('\n'))
    
    // Also remove from tokenList
    setTokenList(currentList => currentList.filter(token => token.address !== addressToRemove))
  }
  
  // Handle clearing all tokens
  const handleClearTokens = () => {
    setTokenMints('')
    setTokenList([])
  }
  
  // Handle token selection for chart display
  const handleSelectToken = useCallback(async (mintAddress: string) => {
    // Show chart for the selected token
    setSelectedToken(mintAddress)
    setIsChartLoading(true)
    
    // Try to find token info from existing sources first
    const searchToken = searchResults.find(token => token.id === mintAddress)
    const listToken = tokenList.find(token => token.address === mintAddress)
    const userToken = userTokens.find(token => token.mintAddress === mintAddress)
    
    let tokenInfo = null
    
    if (searchToken) {
      tokenInfo = {
        address: mintAddress,
        name: searchToken.name,
        symbol: searchToken.symbol,
        icon: searchToken.icon
      }
    } else if (listToken) {
      tokenInfo = listToken
    } else if (userToken) {
      tokenInfo = {
        address: mintAddress,
        name: userToken.name || 'Unknown',
        symbol: userToken.symbol || '???',
        icon: userToken.logoURI
      }
    } else {
      // Fetch token metadata if not found anywhere
      try {
        const res = await fetch(`/api/trending/search?query=${mintAddress}`)
        if (res.ok) {
          const data = await res.json()
          const fetchedToken = Array.isArray(data) ? data.find(t => t.id === mintAddress) : null
          
          if (fetchedToken) {
            tokenInfo = {
              address: mintAddress,
              name: fetchedToken.name || 'Unknown Token',
              symbol: fetchedToken.symbol || '???',
              icon: fetchedToken.icon
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch token info:', error)
      }
    }
    
    setSelectedTokenInfo(tokenInfo)
  }, [searchResults, tokenList, userTokens])

  // Listen for custom event to add token to list
  useEffect(() => {
    const handleAddTokenEvent = (event: CustomEvent) => {
      if (event.detail && event.detail.tokenAddress) {
        handleAddToken(event.detail.tokenAddress)
      }
    }

    // Add event listener
    window.addEventListener('addTokenToList', handleAddTokenEvent as EventListener)

    // Clean up
    return () => {
      window.removeEventListener('addTokenToList', handleAddTokenEvent as EventListener)
    }
  }, [handleAddToken])

  // Debounced search
  useEffect(() => {
    if (!searchTerm) {
      setSearchResults([])
      setShowResults(false) // Don't auto-show when search is empty
      return
    }
    setIsSearching(true)
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/trending/search?query=${encodeURIComponent(searchTerm)}`)
        if (res.ok) {
          const data = await res.json()
          setSearchResults(Array.isArray(data) ? data : [])
          setShowResults(true)
        } else {
          setSearchResults([])
          setShowResults(false) // Don't show if search fails
        }
      } catch {
        setSearchResults([])
        setShowResults(false) // Don't show if search fails
      } finally {
        setIsSearching(false)
      }
}, 350)
   // eslint-disable-next-line
   }, [searchTerm, userTokens.length])

  // Clear outstanding timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current)
    }
  }, [])

  // Hide results on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) {
        setShowResults(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Add mint address from search result
  const handleAddFromSearch = (mintAddress: string) => {
    if (!parsedMints.includes(mintAddress)) {
      const newTokenMints = tokenMints 
        ? tokenMints.trim() + '\n' + mintAddress 
        : mintAddress
      setTokenMints(newTokenMints)
    }
    setShowResults(false)
    setSearchTerm('')
    handleSelectToken(mintAddress)
  }

  // Handle form submission
  const handleBulkBuy = useCallback(async () => {
    if (!connected || !publicKey || !signAllTransactions) {
      setError('Please connect your wallet first')
      return
    }

    if (!solAmount || parseFloat(solAmount) <= 0) {
      setError('Please enter a valid SOL amount')
      return
    }

    if (validMints.length === 0) {
      setError('Please enter at least one valid token mint address')
      return
    }

    if (validMints.length > 10) {
      setError('Maximum 10 token addresses allowed')
      return
    }

    setIsLoading(true)
    setPointsEarned(null)
    setError('')
    setResult(null)

    try {
      // Get balance before operation
      const balanceBeforeOp = await connection.getBalance(publicKey)
      const balanceBeforeSOL = balanceBeforeOp / LAMPORTS_PER_SOL
      setBalanceBefore(balanceBeforeSOL)

      const requiredAmount = parseFloat(solAmount) + (priorityFee * validMints.length) / LAMPORTS_PER_SOL

      if (balanceBeforeSOL < requiredAmount) {
        throw new Error(`Insufficient balance. Required: ${requiredAmount.toFixed(4)} SOL, Available: ${balanceBeforeSOL.toFixed(4)} SOL`)
      }

      const request: BulkBuyRequest = {
        solAmount: parseFloat(solAmount),
        tokenMints: validMints,
        slippage,
        priorityFee,
      }

      const buyResult = await executeBulkBuy(
        request,
        publicKey.toString(),
        connection,
        signAllTransactions
      )

      // Get balance after operation
      const balanceAfterOp = await connection.getBalance(publicKey)
      const balanceAfterSOL = balanceAfterOp / LAMPORTS_PER_SOL
      setBalanceAfter(balanceAfterSOL)

      setResult(buyResult)
      
      // Only show modal if there were actual transaction attempts (success or failure)
      if (buyResult && (buyResult.successfulPurchases.length > 0 || buyResult.failedPurchases.length > 0)) {
        setShowResultModal(true)
      }

      // Track the buy operation
      if (buyResult) {
        const tokenData = validMints.map(mint => {
          const tokenInfo = tokenList.find(t => t.address === mint)
          return {
            mintAddress: mint,
            symbol: tokenInfo?.symbol,
            name: tokenInfo?.name,
            logoURI: tokenInfo?.icon || undefined
          }
        })

        const errors = buyResult.failedPurchases.length > 0 
          ? buyResult.failedPurchases.map(f => f.error)
          : undefined

        // Track buy operation securely via server route for points
        try {
          const trackResult = await trackBuy(
            publicKey.toString(),
            buyResult.successfulPurchases.length,
            {
              failureCount: buyResult.failedPurchases.length,
              solAmount: parseFloat(solAmount),
              tokenMints: validMints,
              signatures: buyResult.signatures,
            }
          );
          console.log(`🎉 Earned ${trackResult.pointsEarned} points from buy operation!`);
          setPointsEarned(trackResult.pointsEarned);
        } catch (trackError) {
          console.error('Failed to track buy operation for points:', trackError);
        }

        // Track operation for PnL and history via React Query
        try {
          // Fetch current token prices and SOL price for accurate tracking
          const { fetchTokenPricesForTracking } = await import('@/utils/trading-tracker')
          
          const [tokenPrices, currentSolPrice] = await Promise.all([
            fetchTokenPricesForTracking(validMints),
            getSolPriceUSD()
          ])

          // Calculate individual SOL amount per successful token purchase
          const successfulTokenCount = buyResult.successfulPurchases.length
          const solAmountPerToken = successfulTokenCount > 0 ? parseFloat(solAmount) / successfulTokenCount : 0

          // Prepare enhanced token data with prices and individual SOL amounts
          const enhancedTokenData = tokenData
            .filter(token => buyResult.successfulPurchases.some(p => p.mintAddress === token.mintAddress))
            .map(token => ({
              ...token,
              priceUsd: tokenPrices[token.mintAddress] || 0,
              tokenAmount: 0, // We don't have exact token amounts from buy result
              solAmount: solAmountPerToken // Individual SOL amount for this token
            }))

          // Track via centralized React Query system
          await trackOperation({
            walletAddress: publicKey.toString(),
            operationType: 'buy',
            tokens: enhancedTokenData.map(token => ({
              ...token,
              solPrice: currentSolPrice
            })),
            successCount: buyResult.successfulPurchases.length,
            failureCount: buyResult.failedPurchases.length,
            totalTokens: buyResult.successfulPurchases.length + buyResult.failedPurchases.length,
            solAmount: parseFloat(solAmount), // Keep total for backward compatibility
            feesPaid: 0, // We don't track this locally yet
            solPriceUsd: currentSolPrice,
            totalUsdValue: currentSolPrice ? parseFloat(solAmount) * currentSolPrice : undefined,
            signatures: buyResult.signatures,
            slippage: slippage / 100,
            priorityFee,
            errors
          })
        } catch (trackError) {
          console.error('Failed to track buy operation for history/PnL:', trackError);
        }
      }

      if (buyResult.success) {
        // Reset form on success and refresh user tokens
        setSolAmount('')
        setTokenMints('')
        loadUserTokens() // Refresh user token list
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred')
    } finally {
      setIsLoading(false)
    }
  }, [connected, publicKey, signAllTransactions, connection, solAmount, validMints, slippage, priorityFee])

  // Fetch wallet balance and user tokens
  useEffect(() => {
    async function fetchBalance() {
      if (connected && publicKey && connection) {
        const lamports = await connection.getBalance(publicKey)
        setWalletBalance(lamports / LAMPORTS_PER_SOL)
      } else {
        setWalletBalance(null)
      }
    }
    fetchBalance()
  }, [connected, publicKey, connection])

  // Handle metadata updates from background enrichment
  const handleMetadataUpdate = useCallback((updatedTokens: UserToken[]) => {
    console.log(`Updating UI with enriched metadata for ${updatedTokens.length} tokens`)
    
    // Update userTokens state
    setUserTokens(prev => prev.map(token => {
      const updated = updatedTokens.find(u => u.mintAddress === token.mintAddress)
      return updated || token
    }))
  }, [])

  // Fetch user's current token holdings
  const loadUserTokens = useCallback(async () => {
    if (!connected || !publicKey) {
      setUserTokens([])
      return
    }

    setIsLoadingUserTokens(true)
    try {
      // Use efficient batch fetching like in BulkTokenSeller
      const tokens = await fetchUserTokensEfficient(
        connection, 
        publicKey, 
        false, // Don't include zero balance
        false, // Exclude NFTs
        (progress) => {
          console.log(`Token fetching progress: ${progress}%`)
        }
      )
      // Filter out tokens with very small values to avoid clutter
      const significantTokens = tokens.filter((token: UserToken) => 
        token.uiAmount > 0.000001 && !token.isNFT
      )
      setUserTokens(significantTokens)
    } catch (error) {
      console.error('Error fetching user tokens:', error)
      setUserTokens([])
    } finally {
      setIsLoadingUserTokens(false)
    }
  }, [connected, publicKey, connection])

  // Fetch user tokens when wallet connects
  useEffect(() => {
    if (connected && publicKey) {
      loadUserTokens()
    } else {
      setUserTokens([])
    }
  }, [connected, publicKey, loadUserTokens])

  // Set up metadata update callback
  useEffect(() => {
    setMetadataUpdateCallback(handleMetadataUpdate)
    return () => clearMetadataUpdateCallback()
  }, [handleMetadataUpdate])

  // Slider value (percentage of wallet balance)
  const maxPercent = 96
  const sliderValue = walletBalance && solAmount ? Math.round((parseFloat(solAmount) / walletBalance) * 100) : 0
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!walletBalance) return
    const percent = parseInt(e.target.value, 10)
    const newAmount = ((walletBalance * percent) / 100).toFixed(4)
    setSolAmount(newAmount)
  }

  // For paste handling
  const handleTokenAreaPaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const pastedText = e.clipboardData.getData('text')
    const pastedAddresses = parseMintAddresses(pastedText)
    
    if (pastedAddresses.length === 0) return
    
    // Add unique addresses to the current list
    const currentAddresses = new Set(parsedMints)
    let newAddresses = ''
    
    pastedAddresses.forEach(addr => {
      if (!currentAddresses.has(addr)) {
        newAddresses += (newAddresses ? '\n' : '') + addr
        currentAddresses.add(addr)
      }
    })
    
    if (newAddresses) {
      const updatedTokenMints = tokenMints ? tokenMints + '\n' + newAddresses : newAddresses
      setTokenMints(updatedTokenMints)
    }
  }

  const feeRates = getAllFeeRates()

  // Fetch Axiom data for a token
  const fetchAxiomData = async (tokenAddress: string) => {
    if (loadingAxiom.has(tokenAddress) || axiomData.has(tokenAddress)) return
    
    setLoadingAxiom(prev => new Set(prev).add(tokenAddress))
    
    try {
      const result = await fetchAxiomTokenInfo(tokenAddress)
      if (result.success && result.data) {
        // Find the token to get its market cap for fee analysis
        const token = tokenList.find(t => t.address === tokenAddress)
        const marketCap = token?.mcap || 0
        const risk = getRiskIndicators(result.data, marketCap)
        setAxiomData(prev => new Map(prev).set(tokenAddress, { data: result.data!, risk }))
      } else if (result.requiresAuth) {
        console.warn('Axiom API requires authentication - risk data unavailable')
      } else if (result.pairNotFound) {
        console.warn(`Token ${tokenAddress} not found in Axiom database - no risk data available`)
        setAxiomData(prev => new Map(prev).set(tokenAddress, { 
          data: null, 
          risk: null,
          pairNotFound: true 
        }))
      }
    } catch (error) {
      console.error(`Failed to fetch Axiom data for ${tokenAddress}:`, error)
    } finally {
      setLoadingAxiom(prev => {
        const newSet = new Set(prev)
        newSet.delete(tokenAddress)
        return newSet
      })
    }
  }

  // Fetch risk data for all tokens in the list
  const fetchAllRiskData = async () => {
    if (validMints.length === 0) return
    
    setShowRiskAnalysis(true)
    const promises = validMints.map(mint => fetchAxiomData(mint))
    await Promise.all(promises)
  }

  // NEW: Keep URL in sync so it can be shared with pre-filled params
  useEffect(() => {
    if (typeof window === 'undefined') return

    // Preserve any existing, unrelated query params
    const params = new URLSearchParams(window.location.search)

    // Update SOL amount param
    if (solAmount && !Number.isNaN(+solAmount) && +solAmount > 0) {
      params.set('sol', solAmount)
    } else {
      params.delete('sol')
    }

    // Update mints param (comma-separated list)
    const mintsParam = validMints.join(',')
    if (mintsParam) {
      params.set('mints', mintsParam)
    } else {
      params.delete('mints')
    }

    const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`
    window.history.replaceState({}, '', newUrl)
  }, [solAmount, tokenMints, validMints])

  return (
    <div className={`grid grid-cols-1 ${connected ? 'lg:grid-cols-3' : 'lg:grid-cols-1'} gap-8`}>
      {/* Trending Tokens Column */}
      {connected && (
      <div className="lg:col-span-1">
        <TrendingTokens onSelectToken={handleSelectToken} />
      </div>
      )}
      
      {/* Main Form Column */}
      <div className="lg:col-span-2">
        <div className="bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-8 space-y-8">
          {/* Header with Wallet Connection */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h2 className="text-3xl font-bold text-white mb-2">Buy 1 - 10 tokens</h2>
              <p className="text-gray-400">Split your SOL across multiple tokens instantly</p>
            </div>
            <div className="shrink-0">
              <WalletSwitcher />
            </div>
          </div>

          {connected && (
            <div className="space-y-8">
              <div className="flex justify-between items-center">
                  <p className="text-xs text-gray-400 flex items-center">
                    <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    Click on the  <svg className="w-4 h-4 mx-1 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                      </svg> icon on Trending Tokens to view price charts
                  </p>
                  {selectedToken && (
                    <button 
                      onClick={() => handleAddToken(selectedToken)}
                      className="text-xs bg-gray-700 text-white py-1 px-3 rounded-md hover:bg-gray-600 transition-colors"
                    >
                      Add Selected Token
                    </button>
                  )}
                </div>

              
              {/* Token Chart Section */}
              {selectedToken && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    {(() => {
                      const selectedTokenData = userTokens.find(token => token.mintAddress === selectedToken)
                      
                      if (selectedTokenData) {
                        return (
                          <>
                            <div className="flex items-center space-x-2">
                              <label className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                                Add your {selectedTokenData.symbol || selectedTokenData.name || 'Token'}
                              </label>
                              {selectedTokenData.logoURI && (
                                <img 
                                  src={selectedTokenData.logoURI} 
                                  alt={selectedTokenData.symbol || selectedTokenData.name || 'Token'} 
                                  className="w-5 h-5 rounded-full" 
                                />
                              )}
                            </div>
                            <div className="text-right">
                              <div className="text-sm text-gray-400">
                               you have {selectedTokenData.uiAmount.toLocaleString(undefined, { 
                                  minimumFractionDigits: 0, 
                                  maximumFractionDigits: 6 
                                })} <span className="text-green-400">~ ${selectedTokenData.usdValue.toFixed(2)}</span>
                              </div>
                            </div>
                          </>
                        )
                                                                    } else {
                         return (
                           <>
                             <div className="flex items-center space-x-2">
                               <label className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                                 Buy {selectedTokenInfo?.symbol || selectedTokenInfo?.name || 'Token'}
                               </label>
                               {selectedTokenInfo?.icon && (
                                 <img 
                                   src={selectedTokenInfo.icon} 
                                   alt={selectedTokenInfo.symbol || selectedTokenInfo.name || 'Token'} 
                                   className="w-5 h-5 rounded-full" 
                                 />
                               )}
                             </div>
                             <div className="text-right">
                               <div className="text-xs text-gray-400">Not in wallet</div>
                             </div>
                           </>
                         )
                       }
                    })()}
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
              {/* SOL Amount Input */}
              <div className="space-y-3">
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="solAmount" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                    SOL to spend
                  </label>
                  {walletBalance !== null && (
                  <div className="flex items-center space-x-3">
                    <input
                      type="range"
                      min={0}
                      max={maxPercent}
                      step={1}
                      value={sliderValue > maxPercent ? maxPercent : sliderValue}
                      onChange={handleSliderChange}
                      disabled={!connected || walletBalance === 0}
                      className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="text-xs text-gray-400 font-mono w-12 text-right">{sliderValue > maxPercent ? maxPercent : sliderValue}%</span>
                  </div>
                )}
                </div>
                <div className="relative">
                  <input
                    id="solAmount"
                    type="number"
                    step="0.001"
                    min="0"
                    value={solAmount}
                    onChange={(e) => setSolAmount(e.target.value)}
                    placeholder="0.1"
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl shadow-inner text-white placeholder-gray-400 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
                    disabled={isLoading}
                  />
                  <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                    <span className="text-gray-400 font-mono text-sm">SOL</span>
                  </div>
                </div>
                <p className="text-xs text-gray-400 flex items-center">
                  <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  This amount will be split equally among all tokens (if buy more than 1 token)
                </p>
              </div>

              {/* Token Mint Addresses */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label htmlFor="tokenMints" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                    Token to buy (up to 10)
                  </label>
                  {tokenList.length > 0 && (
                    <button 
                      type="button"
                      onClick={handleClearTokens}
                      className="text-xs text-gray-400 hover:text-white flex items-center"
                    >
                      <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                      Clear All
                    </button>
                  )}
                </div>
                <div className="relative" ref={searchBoxRef}>
                  <div className="relative">
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      onFocus={() => {
                        // Show owned tokens when focused, regardless of search term
                        if (userTokens.length > 0) {
                          setShowResults(true)
                        }
                      }}
                      placeholder="Search token by name, symbol, or CA"
                      className="w-full pl-4 pr-4 py-3 bg-gray-800 border border-gray-600 rounded-xl shadow-inner text-white placeholder-gray-400 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
                    />
                    <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                      <svg className="h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
                      </svg>
                    </div>
                  </div>
                  {showResults && (searchResults.length > 0 || userTokens.length > 0) && (
                    <div className="absolute z-20 mt-2 w-full bg-gray-900 border border-gray-700 rounded-xl shadow-lg max-h-72 overflow-y-auto">
                      {/* Your Tokens Section */}
                      {userTokens.length > 0 && (
                        <>
                          {!searchTerm && (
                            <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-700 bg-gray-800">
                              Add your bag ({userTokens.length})
                            </div>
                          )}
                          {userTokens
                            .filter(token => 
                              !searchTerm || 
                              token.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                              token.symbol?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                              token.mintAddress.toLowerCase().includes(searchTerm.toLowerCase())
                            )
                            .map((token) => (
                              <button
                                key={`owned-${token.mintAddress}`}
                                type="button"
                                className={`flex items-center w-full px-4 py-2 text-left transition-all ${
                                  parsedMints.includes(token.mintAddress)
                                    ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                                    : 'hover:bg-gray-800 text-white'
                                }`}
                                onClick={() => parsedMints.includes(token.mintAddress) ? null : handleAddFromSearch(token.mintAddress)}
                                disabled={parsedMints.includes(token.mintAddress)}
                              >
                                {token.logoURI && (
                                  <img src={token.logoURI} alt={token.symbol} className="w-6 h-6 mr-3 rounded-full" />
                                )}
                                <div className="flex-1">
                                  <div className="font-semibold flex items-center">
                                    {token.name} 
                                    <span className="text-xs text-gray-400 ml-1">({token.symbol})</span>
                                    {parsedMints.includes(token.mintAddress) && (
                                      <span className="ml-2 text-xs bg-gray-600 text-gray-300 px-2 py-0.5 rounded">Added</span>
                                    )}
                                  </div>
                                  <div className="text-xs text-gray-400 font-mono truncate flex justify-between">
                                    <span>{token.mintAddress}</span>
                                  </div>
                                </div>
                              </button>
                          ))}
                        </>
                      )}
                      
                      {/* Search Results Section */}
                      {searchResults.length > 0 && (
                        <>
                          {userTokens.length > 0 && (
                            <div className="px-4 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-700 bg-gray-800">
                              Search Results
                            </div>
                          )}
                          {searchResults.map((token, idx) => (
                            <button
                              key={`search-${token.id}`}
                              type="button"
                              className="flex items-center w-full px-4 py-2 hover:bg-gray-800 text-left text-white"
                              onClick={() => handleAddFromSearch(token.id)}
                            >
                              {token.icon && (
                                <img src={token.icon} alt={token.symbol} className="w-6 h-6 mr-3 rounded-full" />
                              )}
                              <div className="flex-1">
                                <div className="font-semibold">{token.name} <span className="text-xs text-gray-400">({token.symbol})</span></div>
                                <div className="text-xs text-gray-400 font-mono truncate">{token.id}</div>
                              </div>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                  {showResults && !isSearching && (searchResults.length === 0 && userTokens.length === 0) && (
                    <div className="absolute z-20 mt-2 w-full bg-gray-900 border border-gray-700 rounded-xl shadow-lg p-4 text-gray-400 text-sm">
                      No results found.
                    </div>
                  )}
                </div>
                
                {/* Token List Display */}
                {isLoadingMetadata ? (
                  <div className="max-h-[200px] overflow-y-auto">
                    <TokenSkeleton count={1} variant="token-chips" />
                  </div>
                ) : tokenList.length > 0 ? (
                  <div className="max-h-[200px] overflow-y-auto">
                    <div className="flex flex-wrap gap-2">
                      {tokenList.map((token) => (
                        <div
                          key={token.address}
                          className="flex items-center bg-gray-700 rounded-lg pl-2 pr-1 py-1 text-white"
                        >
                          {token.icon && (
                            <img src={token.icon} alt={token.symbol} className="w-5 h-5 mr-1 rounded-full" />
                          )}
                          <span className="mr-1 text-sm">{token.name}</span>
                          <span className="text-xs text-gray-400 mr-1">({token.symbol})</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveToken(token.address)}
                            className="p-1 rounded-full hover:bg-gray-600"
                          >
                            <svg className="w-3 h-3 text-gray-300" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Risk Analysis Section */}
                {validMints.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                        Risk Analysis
                      </label>
                      <button
                        type="button"
                        onClick={fetchAllRiskData}
                        disabled={validMints.every(mint => axiomData.has(mint) || loadingAxiom.has(mint))}
                        className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white px-3 py-1 rounded-md transition-colors"
                      >
                        {validMints.every(mint => axiomData.has(mint) || loadingAxiom.has(mint)) ? 'Analysis Complete' : 'Analyze All Tokens'}
                      </button>
                    </div>
                    
                    {showRiskAnalysis && (
                      <div className="space-y-2">
                        {validMints.map(mint => {
                          const tokenInfo = tokenList.find(t => t.address === mint)
                          const axiomInfo = axiomData.get(mint)
                          const isLoading = loadingAxiom.has(mint)
                          
                          return (
                            <div key={mint} className="bg-gray-800 border border-gray-600 rounded-lg p-3">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center space-x-2">
                                  {tokenInfo?.icon && (
                                    <img src={tokenInfo.icon} alt={tokenInfo.symbol} className="w-5 h-5 rounded-full" />
                                  )}
                                  <span className="text-sm font-medium text-white">
                                    {tokenInfo?.symbol || 'Unknown'}
                                  </span>
                                </div>
                                {!axiomInfo && !isLoading && (
                                  <button
                                    type="button"
                                    onClick={() => fetchAxiomData(mint)}
                                    className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded"
                                  >
                                    Analyze
                                  </button>
                                )}
                              </div>
                              
                              {isLoading ? (
                                <div className="flex items-center space-x-2 text-gray-400">
                                  <div className="w-4 h-4 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
                                  <span className="text-xs">Analyzing...</span>
                                </div>
                              ) : axiomInfo?.pairNotFound ? (
                                <div className="text-xs text-gray-400">
                                  Token not found in risk database
                                </div>
                              ) : axiomInfo?.data ? (
                                <RiskAnalysis 
                                  tokenAddress={mint} 
                                  marketCap={tokenInfo?.mcap || 0}
                                  axiomData={axiomInfo.data}
                                  riskData={axiomInfo.risk}
                                />
                              ) : (
                                <div className="text-xs text-gray-400">
                                  Click "Analyze" to check token risks
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Hidden textarea for internal state */}
                <textarea
                  id="tokenMints"
                  value={tokenMints}
                  onChange={(e) => setTokenMints(e.target.value)}
                  className="hidden"
                  disabled={isLoading}
                />
                
                <div className="flex justify-between items-center">
                  <div className="flex items-center space-x-4 text-xs">
                    <span className={`flex items-center space-x-1 ${validMints.length > 0 ? 'text-white' : 'text-gray-400'}`}>
                      <div className={`w-2 h-2 rounded-full ${validMints.length > 0 ? 'bg-white' : 'bg-gray-500'}`}></div>
                      <span>Valid: {validMints.length}/10</span>
                    </span>
                    <span className="text-gray-400">
                      Total parsed: {parsedMints.length}
                    </span>
                  </div>
                  {parsedMints.length > validMints.length && (
                    <span className="text-xs text-gray-400">
                      {parsedMints.length - validMints.length} invalid addresses
                    </span>
                  )}
                </div>
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

              {/* Fee Structure Display */}
              {/* <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h3 className="text-sm font-semibold text-blue-800 mb-2">Fee Structure</h3>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div className="text-center">
                    <div className="font-medium text-blue-700">Buy Operations</div>
                    <div className="text-blue-600">{feeRates.buyPercentage}% of SOL budget</div>
                  </div>
                  <div className="text-center">
                    <div className="font-medium text-orange-700">Sell Operations</div>
                    <div className="text-orange-600">{feeRates.sellPercentage}% of SOL received</div>
                  </div>
                  <div className="text-center">
                    <div className="font-medium text-green-700">Close Operations</div>
                    <div className="text-green-600">{feeRates.closeFixed} SOL per account</div>
                  </div>
                </div>
                <div className="mt-2 text-xs text-gray-600 text-center">
                  All fees go to dev wallet • No referral splits
                </div>
              </div> */}

              {/* Buy Button */}
              <button
                onClick={handleBulkBuy}
                disabled={isLoading || !solAmount || validMints.length === 0}
                className={`w-full py-4 px-6 rounded-xl font-semibold text-lg transition-all duration-200 ${
                  isLoading || !solAmount || validMints.length === 0
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                    : 'bg-white hover:bg-gray-100 text-black shadow-lg hover:shadow-xl'
                }`}
              >
                {isLoading ? (
                  <div className="flex items-center justify-center space-x-3">
                    <div className="w-5 h-5 border-2 border-gray-400 border-t-black rounded-full animate-spin"></div>
                    <span>Processing Transactions...</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-center space-x-2">
                    <span>Buy {validMints.length} Token{validMints.length !== 1 ? 's' : ''}</span>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                  </div>
                )}
              </button>

              {/* Error Display */}
              {error && (
                <div className="bg-gray-800 border border-gray-600 text-gray-200 px-4 py-3 rounded-xl">
                  <div className="flex items-start space-x-3">
                    <svg className="w-5 h-5 mt-0.5 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
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
                operation="buy"
                result={result}
                balanceBefore={balanceBefore}
                balanceAfter={balanceAfter}
                onSelectToken={handleSelectToken}
                pointsEarned={pointsEarned ?? undefined}
              />
            </div>
          )}

          {!connected && (
            <div className="text-center py-12">
              <div className="bg-gray-800 border border-gray-600 rounded-2xl p-8">
                <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                {/* <h3 className="text-xl font-semibold text-white mb-2">Connect Your Wallet</h3> */}
                <p className="text-gray-400 mb-6 max-w-md mx-auto">
                  Buy any token in bulk, <br />
                  trade faster and smarter with us
                </p>
                <WalletSwitcher />
                {/* <PhantomWalletButton /> */}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}