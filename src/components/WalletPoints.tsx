'use client'

import React, { useState, useEffect } from 'react'
import { useWallet } from './WalletProvider'
import { getWalletPoints } from '@/utils/operations-api'

interface WalletPointsProps {
  className?: string;
}

export default function WalletPoints({ className = '' }: WalletPointsProps) {
  const { publicKey, connected } = useWallet()
  const [points, setPoints] = useState<number>(0)
  const [stats, setStats] = useState<{
    tokenCount: number;
    swapCount: number;
    closeCount: number;
    breakdown: {
      swapPoints: number;
      closePoints: number;
    };
  } | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

  // Fetch wallet points when wallet connects
  useEffect(() => {
    if (connected && publicKey) {
      fetchPoints()
    } else {
      setPoints(0)
      setStats(null)
      setError('')
    }
  }, [connected, publicKey])

  const fetchPoints = async () => {
    if (!publicKey) return

    setLoading(true)
    setError('')
    
    try {
      const result = await getWalletPoints(publicKey.toString())
      setPoints(result.points)
      setStats({
        tokenCount: result.tokenCount,
        swapCount: result.swapCount,
        closeCount: result.closeCount,
        breakdown: result.breakdown
      })
    } catch (err) {
      console.error('Failed to fetch wallet points:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch points')
    } finally {
      setLoading(false)
    }
  }

  const handleRefresh = () => {
    if (connected && publicKey) {
      fetchPoints()
    }
  }

  return (
    <div>

      {error && (
        <div className="bg-red-900/20 border border-red-700 rounded-lg p-3 mb-4">
          <p className="text-red-400 text-xs">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-4">
          <div className="w-5 h-5 border-2 border-gray-400 border-t-white rounded-full animate-spin mr-3"></div>
          <span className="text-gray-400 text-xs">Loading points...</span>
        </div>
      ) : (
        <div className="flex items-center space-x-1">
          <span className="text-white font-bold text-xs">{points.toLocaleString()}</span>
          <span className="text-gray-400 text-xs">points</span>
        </div>
      )}
    </div>
  )
} 