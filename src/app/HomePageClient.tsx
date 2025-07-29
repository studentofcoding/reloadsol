'use client'

import React, { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import LastReloadTracker from '@/components/LastReloadTracker'
import WalletSwitcher from '@/components/WalletSwitcher'
import Footer from '@/components/Footer'
import { WalletProvider, useWallet } from '@/components/WalletProvider'
import TradingDataProvider from '@/components/TradingDataProvider'
import WelcomeModal from '@/components/WelcomeModal'

function HomeContent() {
  const [showWelcome, setShowWelcome] = useState(false)
  const { connected, hydrated, mounted, availableWallets } = useWallet()
  const router = useRouter()

  // Auto-redirect connected users to sell page, but only after hydration
  useEffect(() => {
    if (!hydrated || !mounted) return

    // Prevent redirect if user explicitly disconnected earlier
    const hasDisconnected = sessionStorage.getItem('hasDisconnected')

    // Check if we just disconnected to prevent redirect loop
    const justDisconnected = sessionStorage.getItem('justDisconnected')
    if (justDisconnected) {
      sessionStorage.removeItem('justDisconnected')
      return
    }

    if (connected && !hasDisconnected) {
      // Set a flag to indicate we're redirecting from home after connection
      sessionStorage.setItem('redirectedFromHome', 'true')
      
      // Small delay to ensure wallet connection is stable
      const timer = setTimeout(() => {
        router.push('/sell')
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [connected, hydrated, mounted, router])

  // Check if user should see welcome modal (only for connected users after hydration)
  useEffect(() => {
    if (!hydrated || !mounted) return

    const welcomeSeen = localStorage.getItem('buyBulkWelcomeSeen')
    if (!welcomeSeen && connected) {
      // Small delay to let the page load first
      const timer = setTimeout(() => {
        setShowWelcome(true)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [connected, hydrated, mounted])

  const handleCloseWelcome = () => {
    setShowWelcome(false)
    localStorage.setItem('buyBulkWelcomeSeen', 'true')
  }

  // Show loading state during hydration to prevent mismatch
  if (!mounted || !hydrated) {
    return (
      <main className="min-h-screen bg-black py-8">
        <div className="container mx-auto px-4">
          <div className="text-center mb-8">
            <h1 className="text-5xl font-bold text-white mb-4">
              reloadSOL
            </h1>
            <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
              Reload your Solana from all worthless memecoins, and trade smartly with us!
              <br />
              Powered by <img className="inline-block h-[1.25rem]" src="https://s3.coinmarketcap.com/static-gravity/image/4dc5810324c74688a5a1b805f7506ec5.jpg" alt="Jupiter Logo" /> Jupiter, <img className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1902372646249234432/T4kNyTq0_400x400.jpg" alt="Superteam Logo" /> Superteam Indonesia and 
              a part of <img className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1843973608378421248/CzmuKtDx_400x400.jpg" alt="Colosseum Breakout" />.
            </h2>
            <div className="mt-6 flex items-center justify-center space-x-6 text-sm text-gray-400">
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse"></div>
                <span>Buy and sell more than 10 tokens</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-600"></div>
                <span>Trending tokens insights</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-1200"></div>
                <span>Catch trend faster and smarter</span>
              </div>
            </div>
            
            {/* Last Reload Tracker */}
            <div className="mt-8 max-w-md mx-auto">
              <LastReloadTracker />
            </div>
          </div>

          {/* Loading state for wallet selection */}
          <div className="max-w-4xl mx-auto mb-10">
            <div className="text-center">
              <div className="animate-pulse">
                <div className="h-8 bg-gray-700 rounded w-48 mx-auto mb-4"></div>
                <div className="h-4 bg-gray-800 rounded w-64 mx-auto mb-8"></div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
                    <div className="w-16 h-16 bg-gray-700 rounded-full mx-auto mb-4"></div>
                    <div className="h-6 bg-gray-700 rounded mb-2"></div>
                    <div className="h-4 bg-gray-800 rounded mb-4"></div>
                    <div className="space-y-2">
                      <div className="h-3 bg-gray-800 rounded"></div>
                      <div className="h-3 bg-gray-800 rounded"></div>
                      <div className="h-3 bg-gray-800 rounded"></div>
                    </div>
                  </div>
                  <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
                    <div className="w-16 h-16 bg-gray-700 rounded-full mx-auto mb-4"></div>
                    <div className="h-6 bg-gray-700 rounded mb-2"></div>
                    <div className="h-4 bg-gray-800 rounded mb-4"></div>
                    <div className="space-y-2">
                      <div className="h-3 bg-gray-800 rounded"></div>
                      <div className="h-3 bg-gray-800 rounded"></div>
                      <div className="h-3 bg-gray-800 rounded"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Feature Cards */}
          <div className="max-w-4xl mx-auto mb-10">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
                <div className="w-12 h-12 bg-gray-700 rounded-lg flex items-center justify-center mb-4">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Lightning Fast</h3>
                <p className="text-gray-400">
                  Process multiple token operations in seconds with optimized batch transactions and Jupiter's best routes.
                </p>
              </div>

              <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
                <div className="w-12 h-12 bg-gray-700 rounded-lg flex items-center justify-center mb-4">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Auto Account Management</h3>
                <p className="text-gray-400">
                  Automatically close empty token accounts after selling to recover rent and keep your wallet clean.
                </p>
              </div>

              <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
                <div className="w-12 h-12 bg-gray-700 rounded-lg flex items-center justify-center mb-4">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Secure & Reliable</h3>
                <p className="text-gray-400">
                  Non-custodial design with proper transaction confirmations and comprehensive error handling for peace of mind.
                </p>
              </div>
            </div>
          </div>
        </div>
        <Footer />
      </main>
    )
  }

  // Check if any wallets are available
  const hasAnyWallet = availableWallets.phantom || availableWallets.embedded

  return (
    <>
      <main className="min-h-screen bg-black py-8">
        <div className="container mx-auto px-4">
          <div className="text-center mb-8">
            <h1 className="text-5xl font-bold text-white mb-4">
              reloadSOL
            </h1>
            <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
              Reload your Solana from all worthless memecoins, and trade smartly with us!
              <br />
              Powered by <img className="inline-block h-[1.25rem]" src="https://s3.coinmarketcap.com/static-gravity/image/4dc5810324c74688a5a1b805f7506ec5.jpg" alt="Jupiter Logo" /> Jupiter, <img className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1902372646249234432/T4kNyTq0_400x400.jpg" alt="Superteam Logo" /> Superteam Indonesia and 
              a part of <img className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1843973608378421248/CzmuKtDx_400x400.jpg" alt="Colosseum Breakout" />.
            </h2>
            <div className="mt-6 flex items-center justify-center space-x-6 text-sm text-gray-400">
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse"></div>
                <span>Buy and sell more than 10 tokens</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-600"></div>
                <span>Trending tokens insights</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-1200"></div>
                <span>Catch trend faster and smarter</span>
              </div>
            </div>
            
            {/* Last Reload Tracker */}
            <div className="mt-8 max-w-md mx-auto">
              <LastReloadTracker />
            </div>
          </div>

          {/* Wallet Section - Show switcher for connected users or wallet selection for disconnected */}
          <div className="max-w-4xl mx-auto mb-10">
            {hasAnyWallet ? (
              <WalletSwitcher />
            ) : (
              <div className="text-center">
                <div className="bg-gray-900 rounded-xl p-8 border border-gray-700">
                  <h3 className="text-xl font-semibold text-white mb-4">No Wallets Found</h3>
                  <p className="text-gray-400 mb-6">
                    To get started, you need either a Phantom wallet or create an embedded wallet.
                  </p>
                  <div className="space-y-4">
                    <p className="text-sm text-gray-500">
                      Or install <a href="https://phantom.app" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300">Phantom wallet</a> and refresh this page
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Feature Cards */}
          <div className="max-w-4xl mx-auto mb-10">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
                <div className="w-12 h-12 bg-gray-700 rounded-lg flex items-center justify-center mb-4">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Lightning Fast</h3>
                <p className="text-gray-400">
                  Process multiple token operations in seconds with optimized batch transactions and Jupiter's best routes.
                </p>
              </div>

              <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
                <div className="w-12 h-12 bg-gray-700 rounded-lg flex items-center justify-center mb-4">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Auto Account Management</h3>
                <p className="text-gray-400">
                  Automatically close empty token accounts after selling to recover rent and keep your wallet clean.
                </p>
              </div>

              <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
                <div className="w-12 h-12 bg-gray-700 rounded-lg flex items-center justify-center mb-4">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Secure & Reliable</h3>
                <p className="text-gray-400">
                  Non-custodial design with proper transaction confirmations and comprehensive error handling for peace of mind.
                </p>
              </div>
            </div>
          </div>
        </div>
        <Footer />
      </main>

      {/* Welcome Modal */}
      {showWelcome && (
        <WelcomeModal 
          isOpen={showWelcome} 
          onClose={handleCloseWelcome} 
        />
      )}
    </>
  )
}

export default function HomePageClient() {
  return (
    <WalletProvider>
      <TradingDataProvider>
        <HomeContent />
      </TradingDataProvider>
    </WalletProvider>
  )
}