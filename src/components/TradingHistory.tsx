'use client'

import React, { useState, useEffect } from 'react'
import { TrackingRecord, TrackingStats } from '@/utils/trading-tracker'
import { useWallet } from './WalletProvider'
import { useTradingData } from './TradingDataProvider'
import TokenSkeleton from './TokenSkeleton'

export default function TradingHistory() {
  const { publicKey, connected } = useWallet()
  const { records: rawRecords, isLoadingRecords } = useTradingData()
  const [processedRecords, setProcessedRecords] = useState<TrackingRecord[]>([])
  const [stats, setStats] = useState<TrackingStats | null>(null)
  const [timeFilter, setTimeFilter] = useState<'all' | '24h' | '7d' | '30d'>('7d')
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

  // Function to process raw records and stats
  const processRecords = React.useCallback(() => {
    if (!connected || !publicKey || !rawRecords) {
      setProcessedRecords([])
      setStats(null)
      return
    }

    try {
      // Get recent successful records only
      const successfulRecords = rawRecords.filter(record => record.successCount > 0)

      // Combine sell and close operations that happen within 30 seconds of each other
      const combinedRecords: TrackingRecord[] = []
      const processedRecordIds = new Set<string>()

      successfulRecords.forEach((record: TrackingRecord) => {
        if (processedRecordIds.has(record.id)) return

        if (record.operationType === 'sell') {
          // Look for a close operation within 30 seconds
          const closeRecord = successfulRecords.find((r: TrackingRecord) => 
            r.operationType === 'close' && 
            !processedRecordIds.has(r.id) &&
            Math.abs(r.timestamp - record.timestamp) <= 30000 // 30 seconds
          )

          if (closeRecord) {
            // Combine sell and close into one record
            const combinedRecord: TrackingRecord = {
              ...record,
              operationType: 'sell' as const, // Keep as 'sell' but it represents sell+close
              tokens: [...record.tokens, ...closeRecord.tokens].filter((token, index, self) => 
                index === self.findIndex(t => t.mintAddress === token.mintAddress)
              ), // Remove duplicates
              successCount: record.successCount + closeRecord.successCount,
              failureCount: record.failureCount + closeRecord.failureCount,
              totalTokens: record.totalTokens + closeRecord.totalTokens,
              signatures: [...record.signatures, ...closeRecord.signatures],
              feesPaid: record.feesPaid + closeRecord.feesPaid,
              errors: [...(record.errors || []), ...(closeRecord.errors || [])]
            }
            
            combinedRecords.push(combinedRecord)
            processedRecordIds.add(record.id)
            processedRecordIds.add(closeRecord.id)
          } else {
            // No matching close operation, keep sell as is
            combinedRecords.push(record)
            processedRecordIds.add(record.id)
          }
        } else if (record.operationType === 'close') {
          // Check if this close wasn't already combined with a sell
          const sellRecord = successfulRecords.find((r: TrackingRecord) => 
            r.operationType === 'sell' && 
            !processedRecordIds.has(r.id) &&
            Math.abs(r.timestamp - record.timestamp) <= 30000 // 30 seconds
          )

          if (!sellRecord) {
            // Standalone close operation
            combinedRecords.push(record)
            processedRecordIds.add(record.id)
          }
          // If there's a matching sell, it will be handled when we process the sell record
        } else {
          // Buy operations and others - keep as is
          combinedRecords.push(record)
          processedRecordIds.add(record.id)
        }
      })

      // Sort by timestamp (most recent first)
      combinedRecords.sort((a, b) => b.timestamp - a.timestamp)

      setProcessedRecords(combinedRecords)
      
      // Calculate stats (simplified version without tradingTracker.getStats)
      const buyCount = combinedRecords.filter(r => r.operationType === 'buy').length
      const sellCount = combinedRecords.filter(r => r.operationType === 'sell').length
      const closeCount = combinedRecords.filter(r => r.operationType === 'close').length
      
      setStats({
        totalOperations: combinedRecords.length,
        totalBuys: buyCount,
        totalSells: sellCount,
        totalCloses: closeCount,
        totalSolSpent: combinedRecords.filter(r => r.operationType === 'buy').reduce((sum, r) => sum + (r.solAmount || 0), 0),
        totalSolReceived: combinedRecords.filter(r => r.operationType === 'sell').reduce((sum, r) => sum + (r.solAmount || 0), 0),
        totalFeesPaid: combinedRecords.reduce((sum, r) => sum + r.feesPaid, 0),
        totalTokensBought: combinedRecords.filter(r => r.operationType === 'buy').reduce((sum, r) => sum + r.successCount, 0),
        totalTokensSold: combinedRecords.filter(r => r.operationType === 'sell').reduce((sum, r) => sum + r.successCount, 0),
        totalAccountsClosed: combinedRecords.filter(r => r.operationType === 'close').reduce((sum, r) => sum + r.successCount, 0),
        successRate: combinedRecords.length > 0 
          ? combinedRecords.reduce((sum, r) => sum + r.successCount, 0) / 
            combinedRecords.reduce((sum, r) => sum + r.successCount + r.failureCount, 0) * 100 
          : 0
      })
    } catch (err) {
      console.error('Error processing trading records:', err)
      setError('Failed to process trading history')
      setProcessedRecords([])
      setStats(null)
    }
  }, [connected, publicKey, rawRecords])

  // Process records when data changes
  useEffect(() => {
    processRecords()
  }, [processRecords])

  // No need for event listeners since React Query handles real-time updates

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
  if (error && error.includes('Browser storage')) {
    return (
      <div className="bg-gray-800 border border-gray-600 rounded-xl p-4 text-center">
        <p className="text-gray-400 text-sm">{error}</p>
      </div>
    )
  }

  // Show loading state
  if (isLoadingRecords) {
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
      {connected && processedRecords.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm">Trade on reloadsol to track your history</p>
        </div>
      ) : (
        <div className="flex space-x-0 overflow-x-auto mb-3 scrollbar-hide">
          {processedRecords.slice(0, 10).map((record: TrackingRecord) => (
            <div
              key={record.id}
              className="flex-shrink-0 hover:bg-gray-700/40 transition-all duration-200 min-w-[180px] rounded-lg cursor-pointer group py-2 px-3 mr-2"
              onClick={() => openTransactionOnSolscan(record.signatures)}
              title="Click to view transaction on Solscan"
            > 
              {/* Line 2: Operation type and amount */}
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-400 capitalize font-medium flex items-center space-x-2">
                    {record.operationType === 'sell' && record.totalTokens > record.tokens.length 
                      ? 'sell & close' 
                      : record.operationType
                    }
                    <div className="flex items-center ml-2 space-x-2">
                      <div className="relative flex items-center">
                        {record.tokens.slice(0, Math.min(record.successCount, 4)).map((token: any, idx: number) => (
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
                        {record.tokens.slice(0, Math.min(record.successCount, 4)).map((token: any, idx: number) => (
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

              {/* Line 1: Timestamp */}
              <div className="flex items-center justify-between text-xs text-gray-400 mt-1">
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
              
              {/* Line 3: Enhanced info with P&L tracking indicator */}
              {/* <div className="flex items-center justify-between mt-2">
                <div className="flex items-center space-x-2">
                  {record.tokens.some(token => token.priceUsd && token.priceUsd > 0) && (
                    <span className="text-green-400 text-xs" title="Accurate price data available">✓</span>
                  )}
                  
                  {record.operationType === 'buy' && (
                    <span className="text-blue-400 text-xs">
                      {record.successCount} token{record.successCount !== 1 ? 's' : ''} bought
                    </span>
                  )}
                  
                  {record.operationType === 'sell' && (
                    <span className="text-orange-400 text-xs">
                      {record.totalTokens > record.tokens.length 
                        ? `${record.tokens.length} sold, ${record.totalTokens - record.tokens.length} closed`
                        : `${record.successCount} token${record.successCount !== 1 ? 's' : ''} sold`
                      }
                    </span>
                  )}
                  
                  {record.operationType === 'close' && (
                    <span className="text-yellow-400 text-xs">
                      {record.successCount} account{record.successCount !== 1 ? 's' : ''} closed
                    </span>
                  )}
                </div>
                
                {record.failureCount > 0 && (
                  <span className="text-red-400 text-xs">
                    {record.failureCount} failed
                  </span>
                )}
              </div> */}
            </div>
          ))}
        </div>
      )}
    </div>
  )
} 