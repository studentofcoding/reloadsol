'use client'

import React, { useState, useCallback, useEffect } from 'react'
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
  
  // UI state
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [result, setResult] = useState<BulkBuyResult | null>(null)
  const [error, setError] = useState<string>('')
  const [selectedToken, setSelectedToken] = useState<string>('')
  const [isChartLoading, setIsChartLoading] = useState<boolean>(false)
  
  // Balance tracking
  const [balanceBefore, setBalanceBefore] = useState<number>(0)
  const [balanceAfter, setBalanceAfter] = useState<number>(0)

  // Parse and validate mint addresses
  const parsedMints = parseMintAddresses(tokenMints)
  const validMints = parsedMints.filter(isValidMintAddress)
  
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
  
  // Handle token selection for chart display
  const handleSelectToken = useCallback((mintAddress: string) => {
    // Show chart for the selected token
    setSelectedToken(mintAddress)
    setIsChartLoading(true)
  }, [])

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
              <h2 className="text-3xl font-bold text-white mb-2">Bulk Token Purchase</h2>
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
                <label htmlFor="solAmount" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                  SOL Amount to Spend
                </label>
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
                  This amount will be split equally among all tokens
                </p>
              </div>

              {/* Token Mint Addresses */}
              <div className="space-y-3">
                <label htmlFor="tokenMints" className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                  Token Mint Addresses (up to 10)
                </label>
                <textarea
                  id="tokenMints"
                  rows={6}
                  value={tokenMints}
                  onChange={(e) => setTokenMints(e.target.value)}
                  placeholder="Enter token mint addresses, one per line or separated by commas/spaces&#10;&#10;Example:&#10;EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&#10;Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB&#10;DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-600 rounded-xl shadow-inner text-white placeholder-gray-400 font-mono text-sm focus:bg-gray-700 focus:border-gray-400 transition-all duration-200 resize-none"
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