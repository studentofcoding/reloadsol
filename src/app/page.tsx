'use client'

import React, { useState, useEffect } from 'react'
import BulkTokenBuyer from '@/components/BulkTokenBuyer'
import BulkTokenSeller from '@/components/BulkTokenSeller'
import WalletBalance from '@/components/WalletBalance'
import TradingHistory from '@/components/TradingHistory'
import PnLTracker from '@/components/PnLTracker'
import LastReloadTracker from '@/components/LastReloadTracker'
import { useWallet } from '@/components/WalletProvider'
import { isDevWallet } from '@/utils/dev-wallet'
import ConnectionStatus from '@/components/ConnectionStatus'
import PhantomWalletButton from '@/components/PhantomWalletButton'
import Footer from '@/components/Footer'
import WelcomeModal from '@/components/WelcomeModal'

export default function Home() {
  const [activeTab, setActiveTab] = useState<'buy' | 'sell'>('sell')
  const [activeInfoTab, setActiveInfoTab] = useState<'history' | 'pnl' | null>('history')
  const [showWelcome, setShowWelcome] = useState(false)
  const { connected, publicKey } = useWallet()

  // Check if user should see welcome modal
  useEffect(() => {
    const welcomeSeen = localStorage.getItem('buyBulkWelcomeSeen')
    if (!welcomeSeen && connected) {
      // Small delay to let the page load first
      const timer = setTimeout(() => {
        setShowWelcome(true)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [connected])

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
                    {!connected && (
              <>
                <div className="mt-6 flex items-center justify-center space-x-6 text-sm text-gray-400">
                  <>
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
                  </>
                </div>
                
                {/* Last Reload Tracker */}
                <div className="mt-8 max-w-md mx-auto">
                  <LastReloadTracker />
                </div>
              </>
            )}
          {connected && (
            <div className="mt-6 flex items-center justify-center space-x-4">
              <ConnectionStatus />
            </div>
          )}
        </div>
        
        {/* Tab Navigation */}
        {connected && (
        <div className="max-w-4xl mx-auto mb-2">
          <div className="flex items-center justify-between h-full mb-4">
            <div className="flex items-center space-x-2">
              {/* Main Trading Tabs */}
              <button
                onClick={() => setActiveTab('sell')}
                className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                  activeTab === 'sell'
                    ? 'bg-white text-black'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                <div className="flex items-center space-x-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span className="hidden md:block">Reload your SOL</span>
                </div>
              </button>
              <button
                onClick={() => setActiveTab('buy')}
                className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                  activeTab === 'buy'
                    ? 'bg-white text-black'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                <div className="flex items-center space-x-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  <span className="hidden md:block">Buy Tokens</span>
                </div>
              </button>

              {/* Info Tabs */}
              <div className="border-l border-gray-600 pl-2 ml-2">
                <button
                  onClick={() => setActiveInfoTab(activeInfoTab === 'history' ? null : 'history')}
                  className={`px-4 py-3 rounded-lg font-medium transition-all duration-200 ${
                    activeInfoTab === 'history'
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                  title="Trading History"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
                {isDevWallet(publicKey) && (
                <button
                  onClick={() => setActiveInfoTab(activeInfoTab === 'pnl' ? null : 'pnl')}
                  className={`px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 ${
                    activeInfoTab === 'pnl'
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                  title="P&L Tracker"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </button>
                )}
              </div>
            </div>

            {/* Wallet Balance Display */}
            <div className="h-full">
              <WalletBalance />
            </div>
          </div>
        </div>
        )}

        {/* Info Tabs Content */}
        {connected && activeInfoTab && (
        <div className="max-w-4xl mx-auto mt-4">
          {activeInfoTab === 'history' && (
            <div>
              <TradingHistory />
            </div>
          )}
          
          {activeInfoTab === 'pnl' && isDevWallet(publicKey) && (
            <div>
              <div className="text-left mb-3">
                <h3 className="text-lg font-semibold text-white">
                  Your PnL Performance 
                  {isDevWallet(publicKey) && (
                    <span className="ml-2 text-xs bg-yellow-600 text-yellow-100 px-2 py-1 rounded">DEV</span>
                  )}
                </h3>
              </div>
              <PnLTracker />
            </div>
          )}
        </div>
        )}

        {/* Tab Content */}
        {connected && (
        <div className="max-w-4xl mx-auto">
          <div>
            {activeTab === 'buy' ? (
              <BulkTokenBuyer />
            ) : (
              <BulkTokenSeller />
            )}
          </div>
        </div>
        )}


        {/* Feature Cards */}
        {!connected && (
          <>
            <div className="max-w-4xl mx-auto mb-10">
              <PhantomWalletButton />
            </div>
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
          </>
        )}
      </div>
      <Footer />
      
      {/* Welcome Modal */}
      <WelcomeModal 
        isOpen={showWelcome} 
        onClose={() => setShowWelcome(false)} 
      />
    </main>
  )
} 