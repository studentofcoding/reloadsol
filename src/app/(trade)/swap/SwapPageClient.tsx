'use client'

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import PhantomWalletButton from '@/components/PhantomWalletButton'
import { useWallet, useConnection } from '@/components/WalletProvider'
import { SLIPPAGE_OPTIONS } from '@/utils/solana'
import { getSwapQuote, getSwapTransaction, isValidMintAddress, fetchUserTokensEfficient, UserToken } from '@/utils/jupiter'
import TokenSkeleton from '@/components/TokenSkeleton'

interface TokenOption {
  mintAddress: string
  symbol: string
  name: string
  logoURI?: string
  decimals: number
  uiAmount?: number
  usdValue?: number
}

interface SwapPageClientProps {
  initialInputMint?: string
  initialOutputMint?: string
}

export default function SwapPageClient({ initialInputMint, initialOutputMint }: SwapPageClientProps) {
  // Wallet & connection
  const { publicKey, connected, signAllTransactions } = useWallet()
  const { connection } = useConnection()

  // Token options state
  const [availableTokens, setAvailableTokens] = useState<TokenOption[]>([])
  const [isLoadingTokens, setIsLoadingTokens] = useState<boolean>(false)

  // Form state
  const [inputAmount, setInputAmount] = useState<string>('0.1')
  const [inputMint, setInputMint] = useState<string>(NATIVE_MINT.toBase58()) // default SOL
  const [outputMint, setOutputMint] = useState<string>('')
  const [slippage, setSlippage] = useState<number>(100) // 1%

  // Token search state
  const [inputSearchTerm, setInputSearchTerm] = useState('')
  const [outputSearchTerm, setOutputSearchTerm] = useState('')
  const [inputSearchResults, setInputSearchResults] = useState<any[]>([])
  const [outputSearchResults, setOutputSearchResults] = useState<any[]>([])
  const [isInputSearching, setIsInputSearching] = useState(false)
  const [isOutputSearching, setIsOutputSearching] = useState(false)
  const [showInputResults, setShowInputResults] = useState(false)
  const [showOutputResults, setShowOutputResults] = useState(false)
  const inputSearchTimeout = useRef<NodeJS.Timeout | null>(null)
  const outputSearchTimeout = useRef<NodeJS.Timeout | null>(null)
  const inputSearchBoxRef = useRef<HTMLDivElement>(null)
  const outputSearchBoxRef = useRef<HTMLDivElement>(null)

  // Quote state
  const [quoteOutAmount, setQuoteOutAmount] = useState<number | null>(null)
  const [lastQuote, setLastQuote] = useState<any | null>(null)
  const [quoteFetching, setQuoteFetching] = useState<boolean>(false)

  // UI / TX state
  const [isSwapping, setIsSwapping] = useState<boolean>(false)
  const [txSignature, setTxSignature] = useState<string | null>(null)
  const [error, setError] = useState<string>('')

  // Chart dimensions
  const [chartDimensions, setChartDimensions] = useState({ width: 500, height: 300 })
  const chartContainerRef = useRef<HTMLDivElement>(null)

  // Refs for timers
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const refreshRef = useRef<NodeJS.Timeout | null>(null)

  // Update URL when tokens change
  useEffect(() => {
    if (typeof window === 'undefined') return

    const params = new URLSearchParams()
    if (inputMint) params.set('input', inputMint)
    if (outputMint) params.set('output', outputMint)

    const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`
    window.history.replaceState({}, '', newUrl)
  }, [inputMint, outputMint])

  // Initialize tokens from URL params
  useEffect(() => {
    if (initialInputMint && isValidMintAddress(initialInputMint)) {
      setInputMint(initialInputMint)
    }
    if (initialOutputMint && isValidMintAddress(initialOutputMint)) {
      setOutputMint(initialOutputMint)
    }
  }, [initialInputMint, initialOutputMint])

  // Load user tokens when wallet connects
  useEffect(() => {
    if (!connected || !publicKey) {
      setAvailableTokens([])
      return
    }

    const loadTokens = async () => {
      setIsLoadingTokens(true)
      try {
        const tokens = await fetchUserTokensEfficient(connection, publicKey, false, false)
        
        // Add SOL as first option
        const solOption: TokenOption = {
          mintAddress: NATIVE_MINT.toBase58(),
          symbol: 'SOL',
          name: 'Solana',
          decimals: 9,
          logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
          uiAmount: tokens.find(t => t.mintAddress === NATIVE_MINT.toBase58())?.uiAmount || 0,
          usdValue: tokens.find(t => t.mintAddress === NATIVE_MINT.toBase58())?.usdValue || 0
        }

        // Convert user tokens to options
        const tokenOptions: TokenOption[] = [
          solOption,
          ...tokens
            .filter(token => token.mintAddress !== NATIVE_MINT.toBase58() && token.uiAmount > 0)
            .map(token => ({
              mintAddress: token.mintAddress,
              symbol: token.symbol || token.name?.substring(0, 4) || '???',
              name: token.name || 'Unknown Token',
              decimals: token.decimals,
              logoURI: token.logoURI,
              uiAmount: token.uiAmount,
              usdValue: token.usdValue
            }))
            .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0)) // Sort by USD value desc
        ]

        setAvailableTokens(tokenOptions)

        // Auto-select largest bag as output if not selected
        if (!outputMint && tokenOptions.length > 1) {
          const largestBag = tokenOptions.find(t => t.mintAddress !== NATIVE_MINT.toBase58())
          if (largestBag) {
            setOutputMint(largestBag.mintAddress)
          }
        }
      } catch (err) {
        console.error('Failed to load tokens:', err)
      } finally {
        setIsLoadingTokens(false)
      }
    }

    loadTokens()
  }, [connected, publicKey, connection, outputMint])

  // Auto-resize chart to maintain aspect ratio
  useEffect(() => {
    const updateChartSize = () => {
      if (chartContainerRef.current) {
        const container = chartContainerRef.current
        const width = container.offsetWidth
        setChartDimensions({ width, height: Math.min(width * 0.6, 400) }) // 3:2 aspect ratio, max 400px height
      }
    }

    updateChartSize()
    window.addEventListener('resize', updateChartSize)
    return () => window.removeEventListener('resize', updateChartSize)
  }, [])

  // Debounced search for input token
  useEffect(() => {
    if (!inputSearchTerm) {
      setInputSearchResults([])
      setShowInputResults(false)
      return
    }
    setIsInputSearching(true)
    if (inputSearchTimeout.current) clearTimeout(inputSearchTimeout.current)
    inputSearchTimeout.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/trending/search?query=${encodeURIComponent(inputSearchTerm)}`)
        if (res.ok) {
          const data = await res.json()
          setInputSearchResults(Array.isArray(data) ? data : [])
          setShowInputResults(true)
        } else {
          setInputSearchResults([])
          setShowInputResults(false)
        }
      } catch {
        setInputSearchResults([])
        setShowInputResults(false)
      } finally {
        setIsInputSearching(false)
      }
    }, 350)
  }, [inputSearchTerm])

  // Debounced search for output token
  useEffect(() => {
    if (!outputSearchTerm) {
      setOutputSearchResults([])
      setShowOutputResults(false)
      return
    }
    setIsOutputSearching(true)
    if (outputSearchTimeout.current) clearTimeout(outputSearchTimeout.current)
    outputSearchTimeout.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/trending/search?query=${encodeURIComponent(outputSearchTerm)}`)
        if (res.ok) {
          const data = await res.json()
          setOutputSearchResults(Array.isArray(data) ? data : [])
          setShowOutputResults(true)
        } else {
          setOutputSearchResults([])
          setShowOutputResults(false)
        }
      } catch {
        setOutputSearchResults([])
        setShowOutputResults(false)
      } finally {
        setIsOutputSearching(false)
      }
    }, 350)
  }, [outputSearchTerm])

  // Hide search results on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (inputSearchBoxRef.current && !inputSearchBoxRef.current.contains(event.target as Node)) {
        setShowInputResults(false)
      }
      if (outputSearchBoxRef.current && !outputSearchBoxRef.current.contains(event.target as Node)) {
        setShowOutputResults(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Get token info by mint address
  const getTokenInfo = useCallback((mintAddress: string): TokenOption | null => {
    return availableTokens.find(token => token.mintAddress === mintAddress) || null
  }, [availableTokens])

  // Fetch quote helper
  const fetchQuote = useCallback(async () => {
    if (!outputMint || !isValidMintAddress(outputMint) || !isValidMintAddress(inputMint)) {
      setQuoteOutAmount(null)
      setLastQuote(null)
      return
    }
    const amount = parseFloat(inputAmount)
    if (Number.isNaN(amount) || amount <= 0) {
      setQuoteOutAmount(null)
      setLastQuote(null)
      return
    }

    try {
      setQuoteFetching(true)
      const inputTokenInfo = getTokenInfo(inputMint)
      const outputTokenInfo = getTokenInfo(outputMint)
      
      const inputDecimals = inputTokenInfo?.decimals || 9
      const outputDecimals = outputTokenInfo?.decimals || 9
      
      const lamports = Math.floor(amount * Math.pow(10, inputDecimals))
      const quote = await getSwapQuote(
        inputMint,
        outputMint,
        lamports,
        slippage
      )

      if (quote && quote.outAmount) {
        setLastQuote(quote)
        const out = parseInt(quote.outAmount) / Math.pow(10, outputDecimals)
        setQuoteOutAmount(out)
      } else {
        setQuoteOutAmount(null)
        setLastQuote(null)
      }
    } catch (err) {
      console.error('Quote error:', err)
      setQuoteOutAmount(null)
      setLastQuote(null)
    } finally {
      setQuoteFetching(false)
    }
  }, [inputMint, outputMint, inputAmount, slippage, getTokenInfo])

  // Debounce quote when user types
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchQuote()
    }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [fetchQuote])

  // Refresh quote every 5 seconds while form is valid
  useEffect(() => {
    if (refreshRef.current) clearInterval(refreshRef.current)
    if (outputMint && isValidMintAddress(outputMint) && inputAmount && isValidMintAddress(inputMint)) {
      refreshRef.current = setInterval(() => {
        fetchQuote()
      }, 5000)
    }
    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current)
    }
  }, [fetchQuote, outputMint, inputAmount, inputMint])

  // Swap handler
  const handleSwap = useCallback(async () => {
    setError('')

    if (!connected || !publicKey || !signAllTransactions) {
      setError('Please connect your wallet first')
      return
    }

    if (!lastQuote) {
      setError('No valid quote available')
      return
    }

    try {
      setIsSwapping(true)
      const swapTx = await getSwapTransaction(lastQuote, publicKey.toString(), 0, [])
      if (!swapTx || !swapTx.swapTransaction) {
        throw new Error('Failed to create swap transaction')
      }

      const tx = VersionedTransaction.deserialize(
        Buffer.from(swapTx.swapTransaction, 'base64')
      )
      const [signedTx] = await signAllTransactions([tx])

      const signature = await connection.sendTransaction(signedTx, {
        skipPreflight: false,
        maxRetries: 3,
      })
      await connection.confirmTransaction(signature, 'confirmed')

      setTxSignature(signature)
      // Clear form after success
      // setInputAmount('')
    } catch (swapErr: any) {
      console.error('Swap error', swapErr)
      setError(swapErr instanceof Error ? swapErr.message : 'Swap failed')
    } finally {
      setIsSwapping(false)
    }
  }, [connected, publicKey, signAllTransactions, connection, lastQuote])

  // Helper to switch input/output mints
  const handleSwitchMints = () => {
    const tempMint = inputMint
    const tempSearchTerm = inputSearchTerm
    
    setInputMint(outputMint)
    setOutputMint(tempMint)
    setInputSearchTerm(outputSearchTerm)
    setOutputSearchTerm(tempSearchTerm)
  }

  // Handle token selection from search
  const handleInputTokenSelect = (token: any) => {
    setInputMint(token.id)
    setInputSearchTerm('')
    setShowInputResults(false)
  }

  const handleOutputTokenSelect = (token: any) => {
    setOutputMint(token.id)
    setOutputSearchTerm('')
    setShowOutputResults(false)
  }

  // Get display token for chart - always show the non-SOL token
  const inputToken = getTokenInfo(inputMint)
  const outputToken = getTokenInfo(outputMint)
  
  // Determine which token to show in chart (prefer non-SOL token)
  const chartToken = useMemo(() => {
    if (!inputToken && !outputToken) return null
    
    // If one is SOL and the other isn't, show the non-SOL token
    if (inputToken?.mintAddress === NATIVE_MINT.toBase58() && outputToken?.mintAddress !== NATIVE_MINT.toBase58()) {
      return outputToken
    }
    if (outputToken?.mintAddress === NATIVE_MINT.toBase58() && inputToken?.mintAddress !== NATIVE_MINT.toBase58()) {
      return inputToken
    }
    
    // If both are non-SOL or both are SOL, prefer output token
    return outputToken || inputToken
  }, [inputToken, outputToken])
  
  // Get the mint address for the chart
  const chartMintAddress = chartToken?.mintAddress

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-white">Token Swap</h2>
        <PhantomWalletButton />
      </div>

      {/* Chart Section */}
      <div className="bg-gray-900 rounded-xl shadow-lg border border-gray-700 p-6" ref={chartContainerRef}>
        {chartToken ? (
          <div className="space-y-3">
            <div className="flex items-center space-x-3">
              {chartToken.logoURI && (
                <img src={chartToken.logoURI} alt={chartToken.symbol} className="w-6 h-6 rounded-full" />
              )}
              <h3 className="text-lg font-semibold text-white">{chartToken.symbol} - {chartToken.name}</h3>
              <span className="text-sm text-gray-400">${chartToken.usdValue?.toFixed(2) || '0.00'}</span>
            </div>
                         <div className="bg-gray-800 border border-gray-600 rounded-lg overflow-hidden">
               <iframe
                 src={`https://www.gmgn.cc/kline/sol/${chartMintAddress}?interval=1D`}
                 width={chartDimensions.width}
                 height={chartDimensions.height}
                 className="w-full"
                 style={{ border: 'none' }}
                 title={`${chartToken.symbol} Price Chart`}
                 allowFullScreen
                 frameBorder="0"
               />
             </div>
          </div>
        ) : (
          <div 
            className="flex items-center justify-center bg-gray-800 border border-gray-600 rounded-lg text-gray-400"
            style={{ height: chartDimensions.height }}
          >
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto mb-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <p className="text-sm">Select a token to view chart</p>
            </div>
          </div>
        )}
      </div>

      {/* Swap Interface */}
      <div className="bg-gray-900 rounded-xl shadow-lg border border-gray-700 p-4">
        
        {/* Main Swap Layout - 3/4 interface + 1/4 swap button */}
        <div className="flex space-x-4">
          
          {/* Swap Interface - 3/4 width */}
          <div className="flex flex-col lg:flex-row w-full gap-4">
            {/* Main Swap Interface */}
            <div className="w-full lg:flex-[3] space-y-4">
            
              {/* Selling Section */}
              <div className="relative">
                <div className="border border-gray-600 rounded-lg p-3 space-y-2">
                  <div className="flex justify-between items-center">
                    <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Selling</h3>
                    <div className="flex space-x-1">
                      <button 
                        onClick={() => {
                          if (inputToken?.uiAmount) {
                            setInputAmount((inputToken.uiAmount / 2).toString())
                          }
                        }}
                        className="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white rounded text-xs font-medium transition-colors"
                        disabled={!inputToken?.uiAmount}
                      >
                        HALF
                      </button>
                      <button 
                        onClick={() => {
                          if (inputToken?.uiAmount) {
                            // Leave small amount for fees if it's SOL
                            const maxAmount = inputToken.mintAddress === NATIVE_MINT.toBase58() 
                              ? Math.max(0, inputToken.uiAmount - 0.01)
                              : inputToken.uiAmount
                            setInputAmount(maxAmount.toString())
                          }
                        }}
                        className="px-2 py-0.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium transition-colors"
                        disabled={!inputToken?.uiAmount}
                      >
                        MAX
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex space-x-2">
                    <div className="flex-1 relative">
                      {/* Token Logo */}
                      {inputToken?.logoURI && (
                        <div className="absolute top-1 right-2 z-10">
                          <img 
                            src={inputToken.logoURI} 
                            alt={inputToken.symbol} 
                            className="w-5 h-5 rounded-full border border-gray-600" 
                          />
                        </div>
                      )}
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={inputAmount}
                        onChange={(e) => setInputAmount(e.target.value)}
                        placeholder="0.1"
                        className="w-full px-2 py-2 pr-8 bg-gray-800 border border-gray-600 rounded text-white text-lg font-semibold placeholder-gray-500 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
                        disabled={isSwapping}
                      />
                    </div>
                    
                    {/* Input Token Search */}
                    <div className="relative w-32" ref={inputSearchBoxRef}>
                      <input
                        type="text"
                        value={inputToken ? `${inputToken.symbol}` : inputSearchTerm}
                        onChange={(e) => {
                          setInputSearchTerm(e.target.value)
                          if (inputToken) {
                            setInputMint('')
                          }
                        }}
                        onFocus={() => {
                          if (availableTokens.length > 0) {
                            setShowInputResults(true)
                          }
                        }}
                        placeholder="Search..."
                        className="w-full px-2 py-2 bg-gray-800 border border-gray-600 rounded text-white text-xs placeholder-gray-500 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
                        disabled={isSwapping || isLoadingTokens}
                      />
                      
                      {showInputResults && (inputSearchResults.length > 0 || availableTokens.length > 0) && (
                        <div className="absolute z-30 mt-1 w-full bg-gray-800 border border-gray-600 rounded shadow-lg max-h-40 overflow-y-auto">
                          {/* User Tokens */}
                          {availableTokens
                            .filter(token => 
                              !inputSearchTerm || 
                              token.name?.toLowerCase().includes(inputSearchTerm.toLowerCase()) ||
                              token.symbol?.toLowerCase().includes(inputSearchTerm.toLowerCase()) ||
                              token.mintAddress.toLowerCase().includes(inputSearchTerm.toLowerCase())
                            )
                            .filter(token => token.mintAddress !== outputMint)
                            .map((token) => (
                              <button
                                key={`input-${token.mintAddress}`}
                                type="button"
                                className="flex items-center w-full px-2 py-1.5 text-left hover:bg-gray-700 text-white text-xs"
                                onClick={async () => {
                                  setInputMint(token.mintAddress)
                                  setInputSearchTerm('')
                                  setShowInputResults(false)
                                  
                                  // Fetch metadata if not available
                                  if (!token.logoURI && token.mintAddress !== NATIVE_MINT.toBase58()) {
                                    try {
                                      const res = await fetch(`/api/trending/search?query=${token.mintAddress}`)
                                      if (res.ok) {
                                        const data = await res.json()
                                        const tokenInfo = Array.isArray(data) ? data.find(t => t.id === token.mintAddress) : null
                                        if (tokenInfo?.icon) {
                                          // Update the token in availableTokens
                                          setAvailableTokens(prev => prev.map(t => 
                                            t.mintAddress === token.mintAddress 
                                              ? { ...t, logoURI: tokenInfo.icon, name: tokenInfo.name || t.name, symbol: tokenInfo.symbol || t.symbol }
                                              : t
                                          ))
                                        }
                                      }
                                    } catch (error) {
                                      console.warn('Failed to fetch token metadata:', error)
                                    }
                                  }
                                }}
                              >
                                {token.logoURI && (
                                  <img src={token.logoURI} alt={token.symbol} className="w-3 h-3 mr-1.5 rounded-full" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium truncate">{token.symbol}</div>
                                  <div className="text-gray-400 truncate text-xs">{token.name}</div>
                                </div>
                                <div className="text-right text-gray-400 text-xs">
                                  <div>${token.usdValue?.toFixed(2) || '0'}</div>
                                </div>
                              </button>
                          ))}
                          
                          {/* Search Results */}
                          {inputSearchResults
                            .filter(token => token.id !== outputMint && token.id !== inputMint)
                            .map((token) => (
                              <button
                                key={`input-search-${token.id}`}
                                type="button"
                                className="flex items-center w-full px-2 py-1.5 text-left hover:bg-gray-700 text-white text-xs"
                                onClick={() => handleInputTokenSelect(token)}
                              >
                                {token.icon && (
                                  <img src={token.icon} alt={token.symbol} className="w-3 h-3 mr-1.5 rounded-full" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium truncate">{token.symbol}</div>
                                  <div className="text-gray-400 truncate text-xs">{token.name}</div>
                                </div>
                              </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {inputToken && (
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <div className="flex items-center space-x-1">
                        <span>Bal: {inputToken.uiAmount?.toFixed(4) || '0'}</span>
                      </div>
                      <span>${inputToken.usdValue?.toFixed(2) || '0.00'}</span>
                    </div>
                  )}
                </div>

                {/* Switch Button - Positioned to overlap */}
                <div className="absolute left-1/2 transform -translate-x-1/2 -bottom-3 z-20">
                  <button
                    type="button"
                    onClick={handleSwitchMints}
                    className="p-1.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded-full transition-colors shadow-lg"
                    disabled={isSwapping || !outputMint || !inputMint}
                  >
                    <svg className="w-3 h-3 text-white transform rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Buying Section */}
              <div className="border border-gray-600 rounded-lg p-3 space-y-2 mt-6">
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Buying</h3>
                
                <div className="flex space-x-2">
                  <div className="flex-1 relative">
                    {/* Token Logo */}
                    {outputToken?.logoURI && (
                      <div className="absolute top-1 right-2 z-10">
                        <img 
                          src={outputToken.logoURI} 
                          alt={outputToken.symbol} 
                          className="w-5 h-5 rounded-full border border-gray-600" 
                        />
                      </div>
                    )}
                    <div className="px-2 py-2 pr-8 bg-gray-800 border border-gray-600 rounded">
                      <div className="text-lg font-semibold text-white">
                        {quoteFetching ? (
                          <div className="flex items-center space-x-1">
                            <div className="w-6 h-6 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
                            <span className="text-lg">Getting quote...</span>
                          </div>
                        ) : quoteOutAmount !== null ? (
                          quoteOutAmount.toFixed(6)
                        ) : (
                          '0'
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {/* Output Token Search */}
                  <div className="relative w-32" ref={outputSearchBoxRef}>
                    <input
                      type="text"
                      value={outputToken ? `${outputToken.symbol}` : outputSearchTerm}
                      onChange={(e) => {
                        setOutputSearchTerm(e.target.value)
                        if (outputToken) {
                          setOutputMint('')
                        }
                      }}
                      onFocus={() => {
                        if (availableTokens.length > 0) {
                          setShowOutputResults(true)
                        }
                      }}
                      placeholder="Search..."
                      className="w-full px-2 py-2 bg-gray-800 border border-gray-600 rounded text-white text-xs placeholder-gray-500 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
                      disabled={isSwapping || isLoadingTokens}
                    />
                    
                    {showOutputResults && (outputSearchResults.length > 0 || availableTokens.length > 0) && (
                      <div className="absolute z-30 mt-1 w-full bg-gray-800 border border-gray-600 rounded shadow-lg max-h-40 overflow-y-auto">
                        {/* User Tokens */}
                        {availableTokens
                          .filter(token => 
                            !outputSearchTerm || 
                            token.name?.toLowerCase().includes(outputSearchTerm.toLowerCase()) ||
                            token.symbol?.toLowerCase().includes(outputSearchTerm.toLowerCase()) ||
                            token.mintAddress.toLowerCase().includes(outputSearchTerm.toLowerCase())
                          )
                          .filter(token => token.mintAddress !== inputMint)
                          .map((token) => (
                            <button
                              key={`output-${token.mintAddress}`}
                              type="button"
                              className="flex items-center w-full px-2 py-1.5 text-left hover:bg-gray-700 text-white text-xs"
                              onClick={async () => {
                                setOutputMint(token.mintAddress)
                                setOutputSearchTerm('')
                                setShowOutputResults(false)
                                
                                // Fetch metadata if not available
                                if (!token.logoURI && token.mintAddress !== NATIVE_MINT.toBase58()) {
                                  try {
                                    const res = await fetch(`/api/trending/search?query=${token.mintAddress}`)
                                    if (res.ok) {
                                      const data = await res.json()
                                      const tokenInfo = Array.isArray(data) ? data.find(t => t.id === token.mintAddress) : null
                                      if (tokenInfo?.icon) {
                                        // Update the token in availableTokens
                                        setAvailableTokens(prev => prev.map(t => 
                                          t.mintAddress === token.mintAddress 
                                            ? { ...t, logoURI: tokenInfo.icon, name: tokenInfo.name || t.name, symbol: tokenInfo.symbol || t.symbol }
                                            : t
                                        ))
                                      }
                                    }
                                  } catch (error) {
                                    console.warn('Failed to fetch token metadata:', error)
                                  }
                                }
                              }}
                            >
                              {token.logoURI && (
                                <img src={token.logoURI} alt={token.symbol} className="w-3 h-3 mr-1.5 rounded-full" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate">{token.symbol}</div>
                                <div className="text-gray-400 truncate text-xs">{token.name}</div>
                              </div>
                              <div className="text-right text-gray-400 text-xs">
                                <div>${token.usdValue?.toFixed(2) || '0'}</div>
                              </div>
                            </button>
                        ))}
                        
                        {/* Search Results */}
                        {outputSearchResults
                          .filter(token => token.id !== inputMint && token.id !== outputMint)
                          .map((token) => (
                            <button
                              key={`output-search-${token.id}`}
                              type="button"
                              className="flex items-center w-full px-2 py-1.5 text-left hover:bg-gray-700 text-white text-xs"
                              onClick={() => handleOutputTokenSelect(token)}
                            >
                              {token.icon && (
                                <img src={token.icon} alt={token.symbol} className="w-3 h-3 mr-1.5 rounded-full" />
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate">{token.symbol}</div>
                                <div className="text-gray-400 truncate text-xs">{token.name}</div>
                              </div>
                            </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                
                {outputToken && (
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <div className="flex items-center space-x-1">
                      <span>Bal: {outputToken.uiAmount?.toFixed(4) || '0'}</span>
                    </div>
                    <span>${outputToken.usdValue?.toFixed(2) || '0.00'}</span>
                  </div>
                )}
              </div>

              {/* Settings */}
              <div className="flex justify-between items-center py-2">
                <label className="text-xs font-medium text-gray-400">Slippage</label>
                <select
                  value={slippage}
                  onChange={(e) => setSlippage(Number(e.target.value))}
                  className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:bg-gray-700 focus:border-gray-400 transition-all"
                  disabled={isSwapping}
                >
                  {SLIPPAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} className="bg-gray-800">
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Error */}
              {error && (
                <div className="bg-red-900/20 border border-red-600 text-red-300 px-3 py-2 rounded text-xs">
                  <div className="flex items-start space-x-2">
                    <svg className="w-3 h-3 mt-0.5 text-red-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <p>{error}</p>
                  </div>
                </div>
              )}

              {/* Success */}
              {txSignature && (
                <div className="bg-green-900/20 border border-green-600 text-green-300 px-3 py-2 rounded text-xs">
                  <p className="break-all">
                    Success:&nbsp;
                    <a
                      href={`https://solscan.io/tx/${txSignature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-green-200"
                    >
                      {txSignature.slice(0, 16)}...
                    </a>
                  </p>
                </div>
              )}
            </div>

            {/* Swap Button - full width on mobile, 1/4 width on desktop */}
            <div className="w-full lg:flex-1">
              <button
                onClick={handleSwap}
                disabled={
                  isSwapping ||
                  !connected ||
                  !inputAmount ||
                  !outputMint ||
                  !inputMint ||
                  quoteOutAmount === null
                }
                className={`w-full lg:h-full min-h-[80px] lg:min-h-[200px] rounded-lg font-bold text-lg transition-all duration-200 ${
                  isSwapping ||
                  !connected ||
                  !inputAmount ||
                  !outputMint ||
                  !inputMint ||
                  quoteOutAmount === null
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                    : 'bg-pink-600 hover:bg-pink-700 text-white shadow-lg hover:shadow-xl'
                }`}
              >
                {isSwapping ? (
                  <div className="flex flex-col items-center justify-center space-y-3">
                    <div className="w-8 h-8 border-3 border-gray-400 border-t-white rounded-full animate-spin"></div>
                    <span className="text-sm">Swapping...</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center space-y-2">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    <span>SWAP</span>
                  </div>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
} 