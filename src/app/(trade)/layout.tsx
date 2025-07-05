'use client'

import React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import WalletBalance from '@/components/WalletBalance'
import ConnectionStatus from '@/components/ConnectionStatus'
import TradingHistory from '@/components/TradingHistory'
import PnLTracker from '@/components/PnLTracker'
import Footer from '@/components/Footer'
import PhantomWalletButton from '@/components/PhantomWalletButton'
import { useWallet } from '@/components/WalletProvider'
import { isDevWallet } from '@/utils/dev-wallet'
import { useState } from 'react'

export default function TradeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const { connected, publicKey } = useWallet()
  const [activeInfoTab, setActiveInfoTab] = useState<'history' | 'pnl' | null>('history')

  const isActive = (path: string) => pathname === path

  return (
    <main className="min-h-screen bg-black py-8">
      <div className="container mx-auto px-4">
        {/* Header */}
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
          
          {connected && (
            <div className="mt-6 flex items-center justify-center space-x-4">
              <ConnectionStatus />
            </div>
          )}
        </div>
        
        {/* Navigation Tabs */}
        {connected && (
          <div className="max-w-4xl mx-auto mb-2">
            <div className="flex items-center justify-between h-full mb-4">
              <div className="flex items-center space-x-2">
                {/* Main Trading Tabs */}
                <Link
                  href="/sell"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive('/sell')
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
                </Link>
                
                <Link
                  href="/buy"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive('/buy')
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
                </Link>

                <Link
                  href="/swap"
                  className={`px-3 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    isActive('/swap')
                      ? 'bg-white text-black'
                      : 'text-gray-400 hover:text-white hover:bg-gray-700'
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    <span className="hidden md:block">Swap</span>
                  </div>
                </Link>

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
                  {isDevWallet(publicKey) && (
                    <button
                      onClick={() => window.open('/dev/trending-tracker', '_blank')}
                      className="px-4 py-3 ml-1 rounded-lg font-medium transition-all duration-200 text-gray-400 hover:text-white hover:bg-gray-800"
                      title="Trending Tracker (Dev)"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
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

        {/* Main Content with fixed minimum height to prevent layout shift */}
        <div className="max-w-4xl mx-auto min-h-[600px]">
        {children}
          {/* {!connected ? (
            <div className="text-center py-12">
              <div className="bg-gray-900 rounded-2xl p-8 border border-gray-700">
                <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Connect Your Wallet</h3>
                <p className="text-gray-400 mb-6 max-w-md mx-auto">
                  Connect your wallet to start trading
                </p>
                <div className="flex gap-4 justify-center mb-6">
                  <a href="/" className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors">
                    Back to Home
                  </a>
                </div>
                <PhantomWalletButton />
              </div>
            </div>
          ) : (
            children
          )} */}
        </div>
      </div>
      
      <Footer />
    </main>
  )
} 