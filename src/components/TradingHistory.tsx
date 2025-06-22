'use client'

import React, { useState, useEffect } from 'react'
import { tradingTracker, TrackingRecord, TrackingStats } from '@/utils/trading-tracker'
import { useWallet } from './WalletProvider'
import TokenSkeleton from './TokenSkeleton'

export default function TradingHistory() {
  const { publicKey, connected } = useWallet()
  const [records, setRecords] = useState<TrackingRecord[]>([])
  const [stats, setStats] = useState<TrackingStats | null>(null)
  const [timeFilter, setTimeFilter] = useState<'all' | '24h' | '7d' | '30d'>('7d')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const [isLocalStorageAvailable, setIsLocalStorageAvailable] = useState<boolean>(true)

  // Check if localStorage is available
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const testKey = '__localStorage_test__'
        localStorage.setItem(testKey, 'test')
        localStorage.removeItem(testKey)
        setIsLocalStorageAvailable(true)
      } else {
        setIsLocalStorageAvailable(false)
      }
    } catch (e) {
      console.warn('localStorage is not available:', e)
      setIsLocalStorageAvailable(false)
      setError('Browser storage is not available. Trading history will not be saved.')
    }
  }, [])

  // Function to load records and stats
  const loadRecords = React.useCallback(() => {
    if (!connected || !publicKey || !isLocalStorageAvailable) {
      setRecords([])
      setStats(null)
      return
    }

    setIsLoading(true)
    setError('')

    try {
    const walletAddress = publicKey.toString()
    
    // Get recent successful records only
    const allRecords = tradingTracker.getWalletRecords(walletAddress)
    const successfulRecords = allRecords.filter(record => record.successCount > 0)

    setRecords(successfulRecords)
    setStats(tradingTracker.getStats(walletAddress))
    } catch (err) {
      console.error('Error loading trading records:', err)
      setError('Failed to load trading history')
      setRecords([])
      setStats(null)
    } finally {
      setIsLoading(false)
    }
  }, [connected, publicKey, isLocalStorageAvailable])

  // Load records and stats
  useEffect(() => {
    loadRecords()
  }, [loadRecords])

  // Listen for new trading records and auto-refresh
  useEffect(() => {
    const handleNewRecord = (event: CustomEvent) => {
      // Auto-refresh when a new trading record is added
      console.log('🔄 New trading record detected, refreshing history...', event.detail)
      setTimeout(() => loadRecords(), 100) // Small delay to ensure localStorage is updated
    }

    // Add event listener
    window.addEventListener('tradingRecordAdded', handleNewRecord as EventListener)

    // Clean up
    return () => {
      window.removeEventListener('tradingRecordAdded', handleNewRecord as EventListener)
    }
  }, [loadRecords])

  const getOperationIcon = (type: string) => {
    switch (type) {
      case 'buy':
        return '🟢'
      case 'sell':
        return '🔴'
      case 'close':
        return '🟡'
      default:
        return '⚪'
    }
  }

  const formatRelativeTime = (timestamp: number) => {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / (1000 * 60))
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`
    return `${days} day${days !== 1 ? 's' : ''} ago`
  }

  const openTransactionOnSolscan = (signatures: string[]) => {
    if (signatures && signatures.length > 0) {
      // Open the first signature on Solscan
      const signature = signatures[0]
      const solscanUrl = `https://solscan.io/tx/${signature}`
      window.open(solscanUrl, '_blank', 'noopener,noreferrer')
    }
  }

  // Show error state
  if (error && !isLocalStorageAvailable) {
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
        <TokenSkeleton count={5} variant="trading-history" />
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

      {/* Horizontal Records List */}
      {connected && records.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm">Trade on reloadsol to track your history</p>
        </div>
      ) : (
        <div className="flex space-x-0 overflow-x-auto mb-3 scrollbar-hide">
          {records.slice(0, 10).map((record) => (
            <div
              key={record.id}
              className="flex-shrink-0 p-0 hover:bg-gray-700/40 transition-all duration-200 min-w-[180px] rounded-lg cursor-pointer group p-4"
              onClick={() => openTransactionOnSolscan(record.signatures)}
              title="Click to view transaction on Solscan"
            >
              {/* Line 1: Timestamp */}
              <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                <span>{formatRelativeTime(record.timestamp)}</span>
                <svg 
                  className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity duration-200" 
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
              </div>
              
              {/* Line 2: Operation type and amount */}
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-400 capitalize font-medium flex items-center space-x-2">
                    {record.operationType}
                    <div className="flex items-center ml-2 space-x-2">
                      <div className="relative flex items-center">
                        {record.tokens.slice(0, Math.min(record.successCount, 4)).map((token, idx) => (
                          <div 
                            key={idx} 
                            className="w-3 h-3 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden"
                            style={{ marginLeft: idx > 0 ? '-0.5rem' : '0' }}
                          >
                            {token.logoURI ? (
                              <img src={token.logoURI} alt={token.symbol || token.name || 'Token'} className="w-full h-full object-cover" onError={(e) => {e.currentTarget.onerror = null; e.currentTarget.src = ''; e.currentTarget.parentElement!.textContent = (token.symbol || token.name || '?').charAt(0).toUpperCase()}} />
                            ) : ((token.symbol || token.name || '?').charAt(0).toUpperCase())}
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center space-x-1">
                        {record.tokens.slice(0, Math.min(record.successCount, 4)).map((token, idx) => (
                          <span key={idx} className="text-xs text-gray-300 font-medium">
                            {token.symbol || token.name || 'Unknown'}
                            {idx < Math.min(record.successCount, 4) - 1 ? ',' : ''}
                          </span>
                        ))}
                        {record.successCount > 4 && <span className="text-xs text-gray-400">+{record.successCount - 4} more</span>}
                      </div>
                    </div>

                    {record.solAmount && record.solAmount > 0 && (
                      <span className="text-xs font-mono">
                        {record.solAmount.toFixed(4)} SOL
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
} 