'use client'

import React, { useState, useEffect } from 'react'
import { useWallet, useConnection } from './WalletProvider'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'

interface WalletBalanceProps {
  onBalanceChange?: (balance: number) => void
}

export default function WalletBalance({ onBalanceChange }: WalletBalanceProps) {
  const { publicKey, connected } = useWallet()
  const { connection } = useConnection()
  const [balance, setBalance] = useState<number>(0)
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const fetchBalance = async () => {
    if (!publicKey || !connected) return
    
    setIsLoading(true)
    try {
      const balanceLamports = await connection.getBalance(publicKey)
      const balanceSOL = balanceLamports / LAMPORTS_PER_SOL
      setBalance(balanceSOL)
      onBalanceChange?.(balanceSOL)
    } catch (error) {
      console.error('Error fetching wallet balance:', error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (connected && publicKey) {
      fetchBalance()
      
      // Set up periodic balance refresh
      const interval = setInterval(fetchBalance, 10000) // Refresh every 10 seconds
      return () => clearInterval(interval)
    } else {
      setBalance(0)
      onBalanceChange?.(0)
    }
  }, [connected, publicKey])

  if (!connected) {
    return null
  }

  return (
    <div className="flex items-center space-x-2 text-sm">
      <div className="flex items-center space-x-2 bg-gray-800 rounded-lg px-3 py-2 border border-gray-600">
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
        </svg>
        <span className="text-gray-400 font-medium">Balance:</span>
        <span className="text-white font-mono">
          {isLoading ? (
            <div className="flex items-center space-x-1">
              <div className="w-3 h-3 border border-gray-400 border-t-white rounded-full animate-spin"></div>
              <span>Loading...</span>
            </div>
          ) : (
            `${balance.toFixed(4)} SOL`
          )}
        </span>
        <button
          onClick={fetchBalance}
          className="ml-1 text-gray-400 hover:text-white transition-colors"
          title="Refresh balance"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
    </div>
  )
} 