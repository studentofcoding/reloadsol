'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { useWallet, useConnection } from '../components/WalletProvider'
import PhantomWalletButton from './PhantomWalletButton'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { 
  executeBulkSell, 
  fetchUserTokens, 
  getTokenSolValue,
  UserToken, 
  BulkSellRequest, 
  BulkSellResult 
} from '@/utils/jupiter'
import { SLIPPAGE_OPTIONS, PRIORITY_FEE_OPTIONS } from '@/utils/solana'

export default function BulkTokenSeller() {
  const { publicKey, signAllTransactions, connected } = useWallet()
  const { connection } = useConnection()
  
  // Form state
  const [selectedTokens, setSelectedTokens] = useState<UserToken[]>([])
  const [slippage, setSlippage] = useState<number>(100) // 1%
  const [priorityFee, setPriorityFee] = useState<number>(100000) // 0.0001 SOL
  
  // UI state
  const [userTokens, setUserTokens] = useState<UserToken[]>([])
  const [isLoadingTokens, setIsLoadingTokens] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [result, setResult] = useState<BulkSellResult | null>(null)
  const [error, setError] = useState<string>('')

  // Fetch user tokens on wallet connection
  useEffect(() => {
    if (connected && publicKey) {
      fetchTokens()
    } else {
      setUserTokens([])
      setSelectedTokens([])
    }
  }, [connected, publicKey])

  const fetchTokens = useCallback(async () => {
    if (!publicKey) return
    
    setIsLoadingTokens(true)
    setError('')
    try {
      const tokens = await fetchUserTokens(connection, publicKey)
      setUserTokens(tokens)
    } catch (error) {
      console.error('Error fetching tokens:', error)
      setError('Failed to fetch your tokens')
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
        return [...prev, token]
      }
    })
  }

  // Refresh individual token price
  const refreshTokenPrice = useCallback(async (token: UserToken) => {
    if (!publicKey) return
    
    // Update the loading state for this specific token
    setUserTokens(prev => prev.map(t => 
      t.mintAddress === token.mintAddress 
        ? { ...t, isLoadingPrice: true }
        : t
    ))
    
    try {
      const solValue = await getTokenSolValue(
        token.mintAddress,
        token.balance,
        token.decimals
      )
      
      // Update the token with new price
      setUserTokens(prev => prev.map(t => 
        t.mintAddress === token.mintAddress 
          ? { ...t, solValue, isLoadingPrice: false }
          : t
      ))
      
      // Update selected tokens if this token is selected
      setSelectedTokens(prev => prev.map(t => 
        t.mintAddress === token.mintAddress 
          ? { ...t, solValue, isLoadingPrice: false }
          : t
      ))
    } catch (error) {
      console.error('Error refreshing token price:', error)
      setUserTokens(prev => prev.map(t => 
        t.mintAddress === token.mintAddress 
          ? { ...t, isLoadingPrice: false }
          : t
      ))
    }
  }, [publicKey])

  // Select all tokens
  const selectAllTokens = () => {
    setSelectedTokens([...userTokens])
  }

  // Clear selection
  const clearSelection = () => {
    setSelectedTokens([])
  }

  // Refresh all token prices
  const refreshAllPrices = useCallback(async () => {
    if (!publicKey || userTokens.length === 0) return
    
    // Set loading state for all tokens
    setUserTokens(prev => prev.map(token => ({ ...token, isLoadingPrice: true })))
    
    try {
      // Update prices in batches
      const BATCH_SIZE = 5
      for (let i = 0; i < userTokens.length; i += BATCH_SIZE) {
        const batch = userTokens.slice(i, i + BATCH_SIZE)
        
        const pricePromises = batch.map(async (token) => {
          try {
            const solValue = await getTokenSolValue(
              token.mintAddress,
              token.balance,
              token.decimals
            )
            return { ...token, solValue, isLoadingPrice: false }
          } catch (error) {
            console.error(`Failed to get price for ${token.symbol}:`, error)
            return { ...token, solValue: 0, isLoadingPrice: false }
          }
        })
        
        const updatedBatch = await Promise.all(pricePromises)
        
        // Update tokens state
        setUserTokens(prev => {
          const newTokens = [...prev]
          updatedBatch.forEach((updatedToken, batchIndex) => {
            const originalIndex = i + batchIndex
            if (originalIndex < newTokens.length) {
              newTokens[originalIndex] = updatedToken
            }
          })
          return newTokens
        })
        
        // Update selected tokens
        setSelectedTokens(prev => prev.map(selectedToken => {
          const updatedToken = updatedBatch.find(t => t.mintAddress === selectedToken.mintAddress)
          return updatedToken || selectedToken
        }))
        
        // Small delay between batches
        if (i + BATCH_SIZE < userTokens.length) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
    } catch (error) {
      console.error('Error refreshing all prices:', error)
      setError('Failed to refresh token prices')
      // Clear loading states
      setUserTokens(prev => prev.map(token => ({ ...token, isLoadingPrice: false })))
    }
  }, [publicKey, userTokens])

  // Handle bulk sell with better error handling
  const handleBulkSell = useCallback(async () => {
    if (!connected || !publicKey || !signAllTransactions) {
      setError('Please connect your wallet first')
      return
    }

    if (selectedTokens.length === 0) {
      setError('Please select at least one token to sell')
      return
    }

    setIsLoading(true)
    setError('')
    setResult(null)

    try {
      const request: BulkSellRequest = {
        tokens: selectedTokens,
        slippage,
        priorityFee,
      }

      const sellResult = await executeBulkSell(
        request,
        publicKey.toString(),
        connection,
        signAllTransactions
      )

      setResult(sellResult)

      if (sellResult.success) {
        // Refresh token list and clear selection
        await fetchTokens()
        setSelectedTokens([])
      }
    } catch (err) {
      console.error('Bulk sell error:', err)
      
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
  }, [connected, publicKey, signAllTransactions, connection, selectedTokens, slippage, priorityFee, fetchTokens])

  const estimatedSOL = selectedTokens.reduce((total, token) => total + token.solValue, 0)

  return (
    <div className="bg-gradient-to-br from-slate-800/90 to-slate-900/90 backdrop-blur-sm rounded-2xl shadow-dark-lg border border-slate-700/50 p-8 space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2">Bulk Token Seller</h2>
          <p className="text-slate-400">Sell your tokens and automatically close accounts</p>
        </div>
        <div className="shrink-0">
          <PhantomWalletButton />
        </div>
      </div>

      {connected && (
        <div className="space-y-8">
          {/* Token Selection Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h3 className="text-xl font-semibold text-white mb-1">Your Tokens</h3>
              <p className="text-slate-400 text-sm">
                Select tokens to sell • {selectedTokens.length} of {userTokens.length} selected
              </p>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={fetchTokens}
                disabled={isLoadingTokens}
                className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg transition-colors text-sm"
              >
                {isLoadingTokens ? 'Refreshing...' : 'Refresh'}
              </button>
              <button
                onClick={refreshAllPrices}
                disabled={isLoadingTokens || userTokens.length === 0}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors text-sm"
              >
                Refresh Prices
              </button>
              <button
                onClick={selectAllTokens}
                disabled={userTokens.length === 0}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm"
              >
                Select All
              </button>
              <button
                onClick={clearSelection}
                disabled={selectedTokens.length === 0}
                className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded-lg transition-colors text-sm"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Token List */}
          {isLoadingTokens ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center space-x-3 text-slate-400">
                <div className="w-5 h-5 border-2 border-slate-400/30 border-t-slate-400 rounded-full animate-spin"></div>
                <span>Loading your tokens...</span>
              </div>
            </div>
          ) : userTokens.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-slate-600 to-slate-700 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-300 mb-2">No tokens found</h3>
              <p className="text-slate-400 mb-4">You don't have any tokens to sell</p>
              <button
                onClick={fetchTokens}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              >
                Refresh Tokens
              </button>
            </div>
          ) : (
            <div className="grid gap-3 max-h-96 overflow-y-auto">
              {userTokens.map((token) => {
                const isSelected = selectedTokens.some(t => t.mintAddress === token.mintAddress)
                return (
                  <div
                    key={token.mintAddress}
                    onClick={() => toggleTokenSelection(token)}
                    className={`group p-4 rounded-xl border cursor-pointer transition-all duration-200 ${
                      isSelected
                        ? 'bg-gradient-to-r from-blue-900/50 to-purple-900/50 border-blue-500/50 shadow-glow'
                        : 'bg-slate-700/30 border-slate-600/50 hover:bg-slate-600/30 hover:border-slate-500/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold ${
                          isSelected ? 'bg-blue-600' : 'bg-slate-600'
                        }`}>
                          {token.symbol?.charAt(0) || 'T'}
                        </div>
                        <div>
                          <div className="font-semibold text-white">
                            {token.symbol || 'Unknown'}
                          </div>
                          <div className="text-sm text-slate-400 font-mono truncate max-w-48">
                            {token.mintAddress}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold text-white">
                          {token.uiAmount.toFixed(6)}
                        </div>
                        <div className="text-sm text-slate-400 flex items-center justify-end space-x-2">
                          {token.isLoadingPrice ? (
                            <div className="flex items-center space-x-1">
                              <div className="w-3 h-3 border border-slate-400/30 border-t-slate-400 rounded-full animate-spin"></div>
                              <span>Loading...</span>
                            </div>
                          ) : (
                            <>
                              <span>≈ {token.solValue.toFixed(6)} SOL</span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  refreshTokenPrice(token)
                                }}
                                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-slate-600/50 rounded"
                                title="Refresh price"
                              >
                                <svg className="w-3 h-3 text-slate-400 hover:text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Settings and Summary */}
          {selectedTokens.length > 0 && (
            <>
              {/* Summary */}
              <div className="bg-gradient-to-r from-blue-900/30 to-purple-900/30 border border-blue-500/30 rounded-xl p-6">
                <h4 className="font-semibold text-blue-200 mb-4">Sale Summary</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="block text-blue-300 font-medium">Tokens Selected</span>
                    <span className="text-xl font-bold text-blue-100">{selectedTokens.length}</span>
                  </div>
                  <div>
                    <span className="block text-blue-300 font-medium">Estimated SOL</span>
                    <span className="text-xl font-bold text-blue-100">{estimatedSOL.toFixed(4)}</span>
                  </div>
                  <div>
                    <span className="block text-blue-300 font-medium">Accounts to Close</span>
                    <span className="text-xl font-bold text-blue-100">{selectedTokens.length}</span>
                  </div>
                  <div>
                    <span className="block text-blue-300 font-medium">Rent Recovery</span>
                    <span className="text-xl font-bold text-blue-100">~{(selectedTokens.length * 0.00203928).toFixed(6)} SOL</span>
                  </div>
                </div>
              </div>

              {/* Settings Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Slippage */}
                <div className="space-y-3">
                  <label htmlFor="slippage" className="block text-sm font-semibold text-slate-200 uppercase tracking-wide">
                    Slippage Tolerance
                  </label>
                  <select
                    id="slippage"
                    value={slippage}
                    onChange={(e) => setSlippage(Number(e.target.value))}
                    className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white focus:bg-slate-700 focus:border-blue-500 transition-all duration-200"
                    disabled={isLoading}
                  >
                    {SLIPPAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-slate-800">
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Priority Fee */}
                <div className="space-y-3">
                  <label htmlFor="priorityFee" className="block text-sm font-semibold text-slate-200 uppercase tracking-wide">
                    Priority Fee
                  </label>
                  <select
                    id="priorityFee"
                    value={priorityFee}
                    onChange={(e) => setPriorityFee(Number(e.target.value))}
                    className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white focus:bg-slate-700 focus:border-blue-500 transition-all duration-200"
                    disabled={isLoading}
                  >
                    {PRIORITY_FEE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value} className="bg-slate-800">
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Sell Button */}
              <button
                onClick={handleBulkSell}
                disabled={isLoading || selectedTokens.length === 0}
                className={`w-full py-4 px-6 rounded-xl font-semibold text-lg transition-all duration-200 ${
                  isLoading || selectedTokens.length === 0
                    ? 'bg-slate-600 text-slate-400 cursor-not-allowed'
                    : 'bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-700 hover:to-orange-700 text-white shadow-glow hover:shadow-glow-lg transform hover:scale-[1.02] active:scale-[0.98]'
                }`}
              >
                {isLoading ? (
                  <div className="flex items-center justify-center space-x-3">
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    <span>Selling & Closing Accounts...</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-center space-x-2">
                    <span>Sell {selectedTokens.length} Token{selectedTokens.length !== 1 ? 's' : ''} & Close</span>
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

          {/* Results Display */}
          {result && (
            <div className="space-y-6 animate-slide-up">
              <div className={`border rounded-xl p-6 backdrop-blur-sm ${
                result.success 
                  ? 'bg-gradient-to-r from-green-900/50 to-emerald-800/50 border-green-500/50' 
                  : 'bg-gradient-to-r from-red-900/50 to-red-800/50 border-red-500/50'
              }`}>
                <h3 className={`font-bold text-lg mb-3 ${result.success ? 'text-green-200' : 'text-red-200'}`}>
                  {result.success ? '🎉 Sale Completed!' : '❌ Sale Failed'}
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div className={result.success ? 'text-green-300' : 'text-red-300'}>
                    <span className="block font-medium">Successful Sales</span>
                    <span className="text-xl font-bold">{result.successfulSales.length}</span>
                  </div>
                  <div className={result.success ? 'text-green-300' : 'text-red-300'}>
                    <span className="block font-medium">Failed Sales</span>
                    <span className="text-xl font-bold">{result.failedSales.length}</span>
                  </div>
                  <div className={result.success ? 'text-green-300' : 'text-red-300'}>
                    <span className="block font-medium">Accounts Closed</span>
                    <span className="text-xl font-bold">{result.successfulCloses.length}</span>
                  </div>
                  <div className={result.success ? 'text-green-300' : 'text-red-300'}>
                    <span className="block font-medium">SOL Received</span>
                    <span className="text-xl font-bold">{result.totalReceived.toFixed(4)}</span>
                  </div>
                </div>
              </div>

              {/* Successful Sales */}
              {result.successfulSales.length > 0 && (
                <div className="bg-gradient-to-r from-green-900/30 to-emerald-800/30 border border-green-500/30 rounded-xl p-6 backdrop-blur-sm">
                  <h4 className="font-semibold text-green-200 mb-4 flex items-center">
                    <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    Successful Sales ({result.successfulSales.length})
                  </h4>
                  <div className="space-y-2">
                    {result.successfulSales.map((sale, index) => (
                      <div key={index} className="bg-green-900/20 rounded-lg p-3 border border-green-500/20">
                        <div className="flex justify-between items-center">
                          <span className="font-mono text-sm text-green-100">{sale.mintAddress}</span>
                          <span className="text-green-200 font-semibold">{sale.solReceived.toFixed(6)} SOL</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Failed Sales */}
              {result.failedSales.length > 0 && (
                <div className="bg-gradient-to-r from-red-900/30 to-red-800/30 border border-red-500/30 rounded-xl p-6 backdrop-blur-sm">
                  <h4 className="font-semibold text-red-200 mb-4 flex items-center">
                    <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    Failed Sales ({result.failedSales.length})
                  </h4>
                  <div className="space-y-3">
                    {result.failedSales.map((failure, index) => (
                      <div key={index} className="bg-red-900/20 rounded-lg p-3 border border-red-500/20">
                        <div className="font-mono text-sm text-red-100 mb-1">{failure.mintAddress}</div>
                        <div className="text-xs text-red-300">{failure.error}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Account Closing Results */}
              {(result.successfulCloses.length > 0 || result.failedCloses.length > 0) && (
                <div className="bg-gradient-to-r from-blue-900/30 to-indigo-800/30 border border-blue-500/30 rounded-xl p-6 backdrop-blur-sm">
                  <h4 className="font-semibold text-blue-200 mb-4 flex items-center">
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Account Closing Results
                  </h4>
                  <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                    <div className="text-blue-300">
                      <span className="block font-medium">Successfully Closed</span>
                      <span className="text-xl font-bold text-blue-100">{result.successfulCloses.length}</span>
                    </div>
                    <div className="text-blue-300">
                      <span className="block font-medium">Failed to Close</span>
                      <span className="text-xl font-bold text-blue-100">{result.failedCloses.length}</span>
                    </div>
                  </div>
                  {result.failedCloses.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-blue-200 text-sm font-medium">Failed to close:</p>
                      {result.failedCloses.map((failure, index) => (
                        <div key={index} className="bg-blue-900/20 rounded-lg p-2 border border-blue-500/20">
                          <div className="font-mono text-xs text-blue-100">{failure.mintAddress}</div>
                          <div className="text-xs text-blue-300">{failure.error}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Transaction Signatures */}
              {result.signatures.length > 0 && (
                <div className="bg-gradient-to-r from-slate-800/50 to-slate-700/50 border border-slate-600/50 rounded-xl p-6 backdrop-blur-sm">
                  <h4 className="font-semibold text-slate-200 mb-4 flex items-center">
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
                        className="block bg-slate-700/30 hover:bg-slate-600/30 rounded-lg p-3 transition-colors border border-slate-600/30 hover:border-blue-500/30"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-sm text-slate-300 truncate mr-4">{sig}</span>
                          <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
          <div className="bg-gradient-to-br from-slate-700/30 to-slate-800/30 border border-slate-600/50 rounded-2xl p-8 backdrop-blur-sm">
            <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-red-500 to-orange-600 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Connect Your Wallet</h3>
            <p className="text-slate-400 mb-6 max-w-md mx-auto">
              Connect your Solana wallet to view and sell your tokens with automatic account closing
            </p>
            <PhantomWalletButton />
          </div>
        </div>
      )}
    </div>
  )
} 