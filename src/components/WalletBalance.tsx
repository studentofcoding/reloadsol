'use client'

import React, { useState, useEffect } from 'react'
import { useWallet, useConnection } from './WalletProvider'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { fetchUserTokens, UserToken } from '@/utils/jupiter'

interface WalletBalanceProps {
  onBalanceChange?: (balance: number) => void
}

export default function WalletBalance({ onBalanceChange }: WalletBalanceProps) {
  const { publicKey, connected } = useWallet()
  const { connection } = useConnection()
  const [balance, setBalance] = useState<number>(0)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [solPrice, setSolPrice] = useState<number>(0)
  const [showUSD, setShowUSD] = useState<boolean>(false)
  const [isPriceLoading, setIsPriceLoading] = useState<boolean>(false)
  const [totalPortfolioValue, setTotalPortfolioValue] = useState<number>(0)
  const [isLoadingPortfolio, setIsLoadingPortfolio] = useState<boolean>(false)
  
  // Refs to hold latest values for async operations
  const balanceRef = React.useRef(0)
  const solPriceRef = React.useRef(0)
  const isFetchingRef = React.useRef(false)

  const fetchBalance = async () => {
    if (!publicKey || !connected) return
    
    // Simple debounce/lock
    if (isLoading) return
    
    setIsLoading(true)
    try {
      const balanceLamports = await connection.getBalance(publicKey)
      const balanceSOL = balanceLamports / LAMPORTS_PER_SOL
      
      if (balanceSOL !== balanceRef.current) {
        console.log('💰 SOL Balance updated:', balanceSOL)
        setBalance(balanceSOL)
        balanceRef.current = balanceSOL
        onBalanceChange?.(balanceSOL)
      }
    } catch (error) {
      console.error('Error fetching wallet balance:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const fetchSolPrice = async () => {
    if (isPriceLoading) return

    setIsPriceLoading(true)
    try {
      const response = await fetch('/api/solprice')
      const data = await response.json()
      if (data.price && data.price > 0 && data.price !== solPriceRef.current) {
        console.log('💲 SOL Price updated:', data.price)
        setSolPrice(data.price)
        solPriceRef.current = data.price
      }
    } catch (error) {
      console.error('Error fetching SOL price:', error)
    } finally {
      setIsPriceLoading(false)
    }
  }

  const fetchTotalPortfolioValue = async () => {
    const currentBalance = balanceRef.current
    const currentPrice = solPriceRef.current

    if (!publicKey || !connected || currentBalance <= 0 || currentPrice <= 0) {
      return
    }
    
    // Prevent concurrent portfolio updates
    if (isFetchingRef.current) return
    
    isFetchingRef.current = true
    setIsLoadingPortfolio(true)
    
    try {
      // Fetch all user tokens with USD values
      const userTokens = await fetchUserTokens(connection, publicKey, false, false)
      
      // Calculate total USD value of all SPL tokens
      const tokensValue = userTokens.reduce((total, token) => total + token.usdValue, 0)
      
      // Calculate SOL value in USD using the passed parameters
      const solValue = currentBalance * currentPrice
      
      // Total portfolio = SPL tokens + SOL
      const totalPortfolio = tokensValue + solValue
      
      setTotalPortfolioValue(totalPortfolio)
      console.log('✅ Portfolio value updated:', totalPortfolio.toFixed(2))
    } catch (error) {
      console.error('❌ Error fetching portfolio value:', error)
    } finally {
      setIsLoadingPortfolio(false)
      isFetchingRef.current = false
    }
  }

  const handleToggleDisplay = () => {
    setShowUSD(prev => !prev)
  }

  const handleRefresh = () => {
    fetchBalance()
    fetchSolPrice()
    // Trigger portfolio update manually in case balance/price didn't change but we want to refresh
    setTimeout(() => {
      fetchTotalPortfolioValue()
    }, 1000)
  }

  // Effect to handle initial data load and periodic updates
  useEffect(() => {
    if (!connected || !publicKey) {
      setBalance(0)
      balanceRef.current = 0
      setTotalPortfolioValue(0)
      return
    }

    // Initial fetch
    fetchBalance()
    fetchSolPrice()

    // Periodic balance refresh (every 30s is enough)
    const balanceInterval = setInterval(fetchBalance, 30000)
    
    // Periodic price refresh (every 60s)
    const priceInterval = setInterval(fetchSolPrice, 60000)

    return () => {
      clearInterval(balanceInterval)
      clearInterval(priceInterval)
    }
  }, [connected, publicKey])

  // Effect to trigger portfolio calculation when balance or price changes
  useEffect(() => {
    if (balance > 0 && solPrice > 0) {
      // Debounce portfolio calculation
      const timeoutId = setTimeout(() => {
        fetchTotalPortfolioValue()
      }, 1000) // Wait 1s after changes settle

      return () => clearTimeout(timeoutId)
    }
  }, [balance, solPrice])

  // Remove the old useEffect that was causing the race condition
  // useEffect(() => {
  //   if (connected && publicKey && balance > 0 && solPrice > 0) {
  //     console.log('🔄 Triggering portfolio recalculation due to balance/price change')
  //     fetchTotalPortfolioValue()
  //   }
  // }, [balance, solPrice, connected, publicKey])

  if (!connected) {
    return (
      <div className="flex items-center space-x-2 text-sm">
        <span className="text-gray-400">Not connected</span>
      </div>
    )
  }

  const renderBalance = () => {
    if (isLoading) {
      return (
        <div className="flex items-center space-x-1">
          <div className="w-3 h-3 border border-gray-400 border-t-white rounded-full animate-spin"></div>
        </div>
      )
    }

    if (showUSD) {
      if (isLoadingPortfolio) {
        return (
          <div className="flex items-center space-x-1">
            <span>$</span>
            <div className="w-3 h-3 border border-gray-400 border-t-white rounded-full animate-spin"></div>
          </div>
        )
      }
      return `$${totalPortfolioValue.toFixed(2)} (Total)`
    }

    return `${balance.toFixed(4)} SOL`
  }

  return (
    <div className="flex items-center space-x-2 text-sm">
      <div className="flex items-center space-x-2">
        <span 
          className="text-white font-mono cursor-pointer hover:text-blue-300 transition-colors"
          onClick={handleToggleDisplay}
          title={showUSD ? "Click to show SOL balance" : "Click to show total portfolio value"}
        >
          {renderBalance()}
        </span>
        <button
          onClick={handleRefresh}
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