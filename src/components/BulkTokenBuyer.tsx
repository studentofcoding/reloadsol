'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useWallet, useConnection } from '../components/WalletProvider'
import PhantomWalletButton from './PhantomWalletButton'
import TrendingTokens from './TrendingTokens'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { executeBulkBuy, parseMintAddresses, isValidMintAddress } from '@/utils/jupiter'
import { SLIPPAGE_OPTIONS, PRIORITY_FEE_OPTIONS } from '@/utils/solana'
import { BulkBuyRequest, BulkBuyResult } from '@/types'

export default function BulkTokenBuyer() {
  const { publicKey, signAllTransactions, connected } = useWallet()
  const { connection } = useConnection()
  
  // Form state
  const [solAmount, setSolAmount] = useState<string>('')
  const [tokenMints, setTokenMints] = useState<string>('')
  const [slippage, setSlippage] = useState<number>(100) // 1%
  const [priorityFee, setPriorityFee] = useState<number>(100000) // 0.0001 SOL
  
  // Token metadata state
  type TokenInfo = {
    address: string;
    name: string;
    symbol: string;
    icon?: string;
  }
  const [tokenList, setTokenList] = useState<TokenInfo[]>([])
  
  // UI state
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [result, setResult] = useState<BulkBuyResult | null>(null)
  const [error, setError] = useState<string>('')
  const [selectedToken, setSelectedToken] = useState<string>('')
  const [isChartLoading, setIsChartLoading] = useState<boolean>(false)
  
  // Balance tracking
  const [balanceBefore, setBalanceBefore] = useState<number>(0)
  const [balanceAfter, setBalanceAfter] = useState<number>(0)
  const [walletBalance, setWalletBalance] = useState<number | null>(null)

  // Token search state
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const searchTimeout = useRef<NodeJS.Timeout | null>(null)
  const searchBoxRef = useRef<HTMLDivElement>(null)

  // Parse and validate mint addresses
  const parsedMints = parseMintAddresses(tokenMints)
  const validMints = parsedMints.filter(isValidMintAddress)
  
  // When tokenMints changes, update tokenList
  useEffect(() => {
    const fetchTokenMetadata = async (addresses: string[]) => {
      // Filter for addresses we don't have metadata for yet
      const existingAddresses = new Set(tokenList.map(token => token.address))
      const addressesToFetch = addresses.filter(addr => !existingAddresses.has(addr) && isValidMintAddress(addr))
      
      if (addressesToFetch.length === 0) return
      
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
              icon: tokenInfo.icon || undefined
            }
          } else {
            return {
              address,
              name: 'Unknown Token',
              symbol: address.substring(0, 4) + '...',
              icon: undefined
            }
          }
        } catch {
          return {
            address,
            name: 'Unknown Token',
            symbol: address.substring(0, 4) + '...',
            icon: undefined
          }
        }
      })
      
      // Execute all fetches in parallel
      const results = await Promise.all(fetchPromises)
      const validResults = results.filter((result): result is TokenInfo => result !== null)
      
      if (validResults.length > 0) {
        setTokenList(currentList => [...currentList, ...validResults])
      }
    }
    
    // Only update if there are valid mints that might not be in the list
    if (validMints.length > 0) {
      fetchTokenMetadata(validMints)
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
  const handleSelectToken = useCallback((mintAddress: string) => {
    // Show chart for the selected token
    setSelectedToken(mintAddress)
    setIsChartLoading(true)
  }, [])

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
      setShowResults(false)
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
          setShowResults(false)
        }
      } catch {
        setSearchResults([])
        setShowResults(false)
      } finally {
        setIsSearching(false)
      }
}, 350)
   // eslint-disable-next-line
   }, [searchTerm])

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

      if (buyResult.success) {
        // Reset form on success
        setSolAmount('')
        setTokenMints('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred')
    } finally {
      setIsLoading(false)
    }
  }, [connected, publicKey, signAllTransactions, connection, solAmount, validMints, slippage, priorityFee])

  // Fetch wallet balance for slider
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* Trending Tokens Column */}
      <div className="lg:col-span-1">
        <TrendingTokens onSelectToken={handleSelectToken} />
      </div>
      
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
              <PhantomWalletButton />
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
              {/* SOL Amount Input */}
              <div className="space-y-3">
                <div className="flex items-center justify-between mb-1">
                  <label htmlFor="solAmount" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                    Total SOL amount to spend
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
                    Token Mint Addresses (up to 10)
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
                      placeholder="Search token by name, symbol, or CA"
                      className="w-full pl-4 pr-4 py-3 bg-gray-800 border border-gray-600 rounded-xl shadow-inner text-white placeholder-gray-400 focus:bg-gray-700 focus:border-gray-400 transition-all duration-200"
                    />
                    <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                      <svg className="h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
                      </svg>
                    </div>
                  </div>
                  {showResults && searchResults.length > 0 && (
                    <div className="absolute z-20 mt-2 w-full bg-gray-900 border border-gray-700 rounded-xl shadow-lg max-h-72 overflow-y-auto">
                      {searchResults.map((token, idx) => (
                        <button
                          key={token.id}
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
                    </div>
                  )}
                  {showResults && !isSearching && searchResults.length === 0 && (
                    <div className="absolute z-20 mt-2 w-full bg-gray-900 border border-gray-700 rounded-xl shadow-lg p-4 text-gray-400 text-sm">
                      No results found.
                    </div>
                  )}
                  {isSearching && (
                    <div className="absolute z-20 mt-2 w-full bg-gray-900 border border-gray-700 rounded-xl shadow-lg p-4 text-gray-400 text-sm">
                      Searching...
                    </div>
                  )}
                </div>
                
                {/* Token List Display */}
                {tokenList.length > 0 && (
                  <div className="bg-gray-800 border border-gray-600 rounded-xl p-3 min-h-[100px] max-h-[200px] overflow-y-auto">
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

              {/* Results Display */}
              {result && (
                <div className="space-y-6">
                  <div className={`border rounded-xl p-6 ${
                    result.success 
                      ? 'bg-gray-800 border-gray-600' 
                      : 'bg-gray-800 border-gray-600'
                  }`}>
                    <h3 className={`font-bold text-lg mb-3 ${result.success ? 'text-white' : 'text-gray-300'}`}>
                      {result.success ? '✅ Purchase Completed!' : '❌ Purchase Failed'}
                    </h3>
                    
                    {/* Balance Change Display */}
                    {balanceBefore > 0 && balanceAfter > 0 && (
                      <div className="mb-4 p-4 bg-gray-700 rounded-lg">
                        <h4 className="text-sm font-semibold text-gray-200 mb-2">Wallet Balance Change</h4>
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          <div>
                            <span className="block text-gray-400">Before</span>
                            <span className="text-white font-mono">{balanceBefore.toFixed(4)} SOL</span>
                          </div>
                          <div>
                            <span className="block text-gray-400">After</span>
                            <span className="text-white font-mono">{balanceAfter.toFixed(4)} SOL</span>
                          </div>
                          <div>
                            <span className="block text-gray-400">Difference</span>
                            <span className="text-white font-mono">
                              {(balanceAfter - balanceBefore).toFixed(4)} SOL
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                      <div className="text-white">
                        <span className="block font-medium">Successful</span>
                        <span className="text-xl font-bold">{result.successfulPurchases.length}</span>
                      </div>
                      <div className="text-white">
                        <span className="block font-medium">Failed</span>
                        <span className="text-xl font-bold">{result.failedPurchases.length}</span>
                      </div>
                      <div className="text-white md:col-span-1 col-span-2">
                        <span className="block font-medium">Total Spent</span>
                        <span className="text-xl font-bold">{result.totalSpent.toFixed(4)} SOL</span>
                      </div>
                    </div>
                  </div>

                  {/* Successful Purchases */}
                  {result.successfulPurchases.length > 0 && (
                    <div className="bg-gray-800 border border-gray-600 rounded-xl p-6">
                      <h4 className="font-semibold text-white mb-4 flex items-center">
                        <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        Successful Purchases ({result.successfulPurchases.length})
                      </h4>
                      <div className="space-y-2">
                        {result.successfulPurchases.map((purchase, index) => (
                          <div 
                            key={index} 
                            className="bg-gray-700 rounded-lg p-3 font-mono text-sm text-white border border-gray-600 cursor-pointer hover:border-gray-500"
                            onClick={() => handleAddToken(purchase.mintAddress)}
                          >
                            <div className="flex justify-between items-center">
                              <span>{purchase.mintAddress}</span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleSelectToken(purchase.mintAddress)
                                }}
                                className="p-1 bg-gray-600 rounded hover:bg-gray-500 transition-colors"
                              >
                                <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Failed Purchases */}
                  {result.failedPurchases.length > 0 && (
                    <div className="bg-gray-800 border border-gray-600 rounded-xl p-6">
                      <h4 className="font-semibold text-gray-300 mb-4 flex items-center">
                        <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                        Failed Purchases ({result.failedPurchases.length})
                      </h4>
                      <div className="space-y-3">
                        {result.failedPurchases.map((failure, index) => (
                          <div 
                            key={index} 
                            className="bg-gray-700 rounded-lg p-3 border border-gray-600 cursor-pointer hover:border-gray-500"
                            onClick={() => handleAddToken(failure.mintAddress)}
                          >
                            <div className="font-mono text-sm text-white mb-1 flex justify-between items-center">
                              <span>{failure.mintAddress}</span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleSelectToken(failure.mintAddress)
                                }}
                                className="p-1 bg-gray-600 rounded hover:bg-gray-500 transition-colors"
                              >
                                <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                                </svg>
                              </button>
                            </div>
                            <div className="text-xs text-gray-400">{failure.error}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Transaction Signatures */}
                  {result.signatures.length > 0 && (
                    <div className="bg-gray-800 border border-gray-600 rounded-xl p-6">
                      <h4 className="font-semibold text-white mb-4 flex items-center">
                        <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Transaction Signatures ({result.signatures.length})
                      </h4>
                      <div className="space-y-2">
                        {result.signatures.map((sig, index) => (
                          <a
                            key={index}
                            href={`https://solscan.io/tx/${sig}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block bg-gray-700 hover:bg-gray-600 rounded-lg p-3 transition-colors border border-gray-600 hover:border-gray-400"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-sm text-gray-300 truncate mr-4">{sig}</span>
                              <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </div>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
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
                <h3 className="text-xl font-semibold text-white mb-2">Connect Your Wallet</h3>
                <p className="text-gray-400 mb-6 max-w-md mx-auto">
                  Connect your Solana wallet to start buying tokens in bulk with our secure interface
                </p>
                <PhantomWalletButton />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
} 