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

  const fetchBalance = async (shouldTriggerPortfolioUpdate = true) => {
    if (!publicKey || !connected) return
    
    console.log('🔄 fetchBalance called:', { shouldTriggerPortfolioUpdate, currentSolPrice: solPrice })
    setIsLoading(true)
    try {
      const balanceLamports = await connection.getBalance(publicKey)
      const balanceSOL = balanceLamports / LAMPORTS_PER_SOL
      console.log('💰 SOL Balance fetched:', balanceSOL, 'Previous balance:', balance)
      setBalance(balanceSOL)
      onBalanceChange?.(balanceSOL)
      
      // Trigger portfolio calculation after balance is updated, if we have price
      if (shouldTriggerPortfolioUpdate && solPrice > 0) {
        console.log('🔄 Triggering portfolio calculation after balance update with price:', solPrice)
        setTimeout(async () => {
          console.log('⏰ Portfolio calc timeout - balance:', balanceSOL, 'price:', solPrice)
          await fetchTotalPortfolioValueWithParams(balanceSOL, solPrice)
        }, 100)
      } else {
        console.log('⏸️ Skipping portfolio calc after balance - shouldTrigger:', shouldTriggerPortfolioUpdate, 'solPrice:', solPrice)
      }
    } catch (error) {
      console.error('Error fetching wallet balance:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const fetchSolPrice = async (shouldTriggerPortfolioUpdate = true) => {
    console.log('🔄 fetchSolPrice called:', { shouldTriggerPortfolioUpdate, currentBalance: balance })
    setIsPriceLoading(true)
    try {
      const response = await fetch('/api/solprice')
      const data = await response.json()
      if (data.price && data.price > 0) {
        console.log('💲 SOL Price fetched:', data.price, 'Previous price:', solPrice)
        setSolPrice(data.price)
        
        // Trigger portfolio calculation after price is updated, if we have balance
        if (shouldTriggerPortfolioUpdate && balance > 0) {
          console.log('🔄 Triggering portfolio calculation after price update with balance:', balance)
          setTimeout(async () => {
            console.log('⏰ Portfolio calc timeout - balance:', balance, 'price:', data.price)
            await fetchTotalPortfolioValueWithParams(balance, data.price)
          }, 100)
        } else {
          console.log('⏸️ Skipping portfolio calc after price - shouldTrigger:', shouldTriggerPortfolioUpdate, 'balance:', balance)
        }
      }
    } catch (error) {
      console.error('Error fetching SOL price:', error)
    } finally {
      setIsPriceLoading(false)
    }
  }

  const fetchTotalPortfolioValueWithParams = async (currentBalance: number, currentPrice: number) => {
    if (!publicKey || !connected) {
      console.log('❌ Portfolio calc skipped - not connected')
      return
    }
    
    console.log('📊 Starting portfolio calculation with params:', { 
      currentBalance, 
      currentPrice,
      stateBalance: balance,
      stateSolPrice: solPrice
    })
    
    // Don't calculate if we don't have both balance and price
    if (currentBalance <= 0 || currentPrice <= 0) {
      console.log('⏳ Skipping portfolio calculation - missing data:', { 
        balance: currentBalance, 
        solPrice: currentPrice 
      })
      return
    }
    
    setIsLoadingPortfolio(true)
    try {
      // Fetch all user tokens with USD values
      console.log('🔍 Fetching user tokens...')
      const userTokens = await fetchUserTokens(connection, publicKey, false, false)
      console.log('📋 User tokens fetched:', userTokens.length, 'tokens')
      
      // Calculate total USD value of all SPL tokens
      const tokensValue = userTokens.reduce((total, token) => total + token.usdValue, 0)
      
      // Calculate SOL value in USD using the passed parameters
      const solValue = currentBalance * currentPrice
      
      // Total portfolio = SPL tokens + SOL
      const totalPortfolio = tokensValue + solValue
      
      console.log('📊 Portfolio Calculation Complete:', {
        solBalance: currentBalance,
        solPrice: currentPrice,
        solValueUSD: solValue,
        splTokensValueUSD: tokensValue,
        totalPortfolioUSD: totalPortfolio,
        tokenCount: userTokens.length,
        previousPortfolioValue: totalPortfolioValue
      })
      
      setTotalPortfolioValue(totalPortfolio)
      console.log('✅ Portfolio value updated to:', totalPortfolio)
    } catch (error) {
      console.error('❌ Error fetching portfolio value:', error)
    } finally {
      setIsLoadingPortfolio(false)
    }
  }

  const fetchTotalPortfolioValue = async () => {
    await fetchTotalPortfolioValueWithParams(balance, solPrice)
  }

  const handleToggleDisplay = () => {
    setShowUSD(prev => !prev)
  }

  const handleRefresh = () => {
    // Fetch balance and price first, then they will trigger portfolio calculation
    fetchBalance(false) // Don't auto-trigger portfolio calc
    fetchSolPrice(false) // Don't auto-trigger portfolio calc
    
    // Wait a bit then manually trigger portfolio calculation
    setTimeout(() => {
      fetchTotalPortfolioValue()
    }, 1000)
  }

  useEffect(() => {
    console.log('🚀 WalletBalance useEffect triggered:', { connected, publicKey: !!publicKey })
    if (connected && publicKey) {
      console.log('🔄 Starting initial data fetch...')
      
      // Fetch both balance and price, but don't auto-trigger portfolio calc
      const initializeData = async () => {
        console.log('📥 Phase 1: Fetching balance and price...')
        await Promise.all([
          fetchBalance(false),
          fetchSolPrice(false)
        ])
        
        console.log('📥 Phase 2: Data fetched, waiting for state updates...')
        // Wait a bit for state updates, then trigger portfolio calculation
        setTimeout(() => {
          console.log('📊 Phase 3: Triggering initial portfolio calculation...')
          fetchTotalPortfolioValue()
        }, 500)
      }
      
      initializeData()
      
      // Set up periodic balance refresh every 10 seconds
      const balanceInterval = setInterval(() => {
        console.log('⏰ Periodic balance refresh')
        fetchBalance()
      }, 10000)
      
      // Set up periodic price refresh every 30 seconds (matches API cache)
      const priceInterval = setInterval(() => {
        console.log('⏰ Periodic price refresh')
        fetchSolPrice()
      }, 30000)
      
      // Set up periodic portfolio refresh every 30 seconds
      const portfolioInterval = setInterval(() => {
        console.log('⏰ Periodic portfolio refresh')
        fetchTotalPortfolioValue()
      }, 30000)
      
      return () => {
        console.log('🧹 Cleaning up intervals')
        clearInterval(balanceInterval)
        clearInterval(priceInterval)
        clearInterval(portfolioInterval)
      }
    } else {
      console.log('🔌 Wallet disconnected, resetting values')
      setBalance(0)
      setShowUSD(false)
      setTotalPortfolioValue(0)
      onBalanceChange?.(0)
    }
  }, [connected, publicKey])

  // Remove the old useEffect that was causing the race condition
  // useEffect(() => {
  //   if (connected && publicKey && balance > 0 && solPrice > 0) {
  //     console.log('🔄 Triggering portfolio recalculation due to balance/price change')
  //     fetchTotalPortfolioValue()
  //   }
  // }, [balance, solPrice, connected, publicKey])

  if (!connected) {
    return null
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