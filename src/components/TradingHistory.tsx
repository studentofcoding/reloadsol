'use client'

import React, { useState, useEffect } from 'react'
import { tradingTracker, TrackingRecord, TrackingStats } from '@/utils/trading-tracker'
import { useWallet } from './WalletProvider'

export default function TradingHistory() {
  const { publicKey, connected } = useWallet()
  const [records, setRecords] = useState<TrackingRecord[]>([])
  const [stats, setStats] = useState<TrackingStats | null>(null)
  const [timeFilter, setTimeFilter] = useState<'all' | '24h' | '7d' | '30d'>('7d')

  // Function to load records and stats
  const loadRecords = React.useCallback(() => {
    if (!connected || !publicKey) {
      setRecords([])
      setStats(null)
      return
    }

    const walletAddress = publicKey.toString()
    
    // Get recent successful records only
    const allRecords = tradingTracker.getWalletRecords(walletAddress)
    const successfulRecords = allRecords.filter(record => record.successCount > 0)

    setRecords(successfulRecords)
    setStats(tradingTracker.getStats(walletAddress))
  }, [connected, publicKey])

  // Load records and stats
  useEffect(() => {
    loadRecords()
  }, [loadRecords])

  // Listen for new trading records and auto-refresh
  useEffect(() => {
    const handleNewRecord = (event: CustomEvent) => {
      // Auto-refresh when a new trading record is added
      console.log('🔄 New trading record detected, refreshing history...')
      loadRecords()
    }

    // Add event listener
    window.addEventListener('tradingRecordAdded', handleNewRecord as EventListener)

    // Clean up
    return () => {
      window.removeEventListener('tradingRecordAdded', handleNewRecord as EventListener)
    }
  }, [loadRecords])

  if (!connected) {
    return (
      <div className="bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-8">
        <div className="text-center">
          <h3 className="text-xl font-semibold text-white mb-2">Trading History</h3>
          <p className="text-gray-400">Connect your wallet to see trading history</p>
        </div>
      </div>
    )
  }

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

  const clearHistory = () => {
    if (confirm('Are you sure you want to clear all trading history? This cannot be undone.')) {
      tradingTracker.clearAllRecords()
      setRecords([])
      setStats(null)
    }
  }

  const exportHistory = () => {
    const dataStr = tradingTracker.exportRecords()
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr)
    
    const exportFileDefaultName = `trading-history-${publicKey?.toString().slice(0, 8)}-${Date.now()}.json`
    
    const linkElement = document.createElement('a')
    linkElement.setAttribute('href', dataUri)
    linkElement.setAttribute('download', exportFileDefaultName)
    linkElement.click()
  }

  return (
    <div className="">

      {/* Horizontal Records List */}
      {records.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm">Trade on reloadsol to track your history</p>
        </div>
      ) : (
        <div className="flex space-x-4 overflow-x-auto p-3 px-1">
          {records.slice(0, 10).map((record) => (
            <div
              key={record.id}
              className="flex-shrink-0 p-0 hover:bg-gray-800/30 transition-colors min-w-[180px] rounded-lg"
            >
              {/* Line 1: Timestamp */}
              <div className="text-xs text-gray-400 mb-1">
                {formatRelativeTime(record.timestamp)}
              </div>
              
              {/* Line 2: Operation type and amount */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-400 capitalize font-medium flex items-center space-x-2">
                    {record.operationType}
                    {record.tokens.slice(0, Math.min(record.successCount, 4)).map((token, idx) => (
                      <div key={idx} className="flex items-center ml-2 space-x-2">
                        <div className="w-3 h-3 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden">
                          {token.logoURI ? (
                            <img src={token.logoURI} alt={token.symbol || token.name || 'Token'} className="w-full h-full object-cover" onError={(e) => {e.currentTarget.onerror = null; e.currentTarget.src = ''; e.currentTarget.parentElement!.textContent = (token.symbol || token.name || '?').charAt(0).toUpperCase()}} />
                          ) : ((token.symbol || token.name || '?').charAt(0).toUpperCase())}
                        </div>
                        <span className="text-xs text-gray-300 font-medium">{token.symbol || token.name || 'Unknown'}</span>
                      </div>
                    ))}
                    {record.successCount > 4 && <span className="text-xs text-gray-400">+{record.successCount - 4} more tokens</span>}

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