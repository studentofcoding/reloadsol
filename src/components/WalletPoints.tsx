'use client'

import React from 'react'
import { useWallet } from './WalletProvider'
import { useWalletPoints } from '@/hooks/useWalletPoints'

interface WalletPointsProps {
  className?: string;
}

export default function WalletPoints({ className = '' }: WalletPointsProps) {
  const { publicKey, connected } = useWallet()
  const walletAddress = connected && publicKey ? publicKey.toString() : null
  const { data, isLoading: loading, error: queryError, refetch } = useWalletPoints(walletAddress)

  const points = data?.points ?? 0
  const error = queryError instanceof Error ? queryError.message : ''

  const handleRefresh = () => {
    if (walletAddress) {
      void refetch()
    }
  }

  return (
    <div className={`min-h-[20px] ${className}`} onClick={handleRefresh}>
      {error && (
        <div className="bg-red-900/20 border border-red-700 rounded px-2 py-1 flex items-center space-x-1 min-h-[20px]">
          <p className="text-red-400 text-xs">{error}</p>
        </div>
      )}

      {!error && (
        <div className="flex items-center space-x-1 min-h-[20px]">
          {loading ? (
            <>
              <div className="w-3 h-3 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
              <span className="text-gray-400 text-xs">Loading points...</span>
            </>
          ) : (
            <>
              <span className="text-white font-bold text-xs">{points.toLocaleString()}</span>
              <span className="text-gray-400 text-xs">points</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
