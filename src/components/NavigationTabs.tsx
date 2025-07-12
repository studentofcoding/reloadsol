'use client'

import React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import WalletBalance from '@/components/WalletBalance'
import { useWallet } from '@/components/WalletProvider'
import { isDevWallet } from '@/utils/dev-wallet'

interface NavigationTabsProps {
  activeInfoTab: 'history' | 'pnl' | null
  setActiveInfoTab: (tab: 'history' | 'pnl' | null) => void
}

export default function NavigationTabs({ activeInfoTab, setActiveInfoTab }: NavigationTabsProps) {
  const pathname = usePathname()
  const { connected, publicKey } = useWallet()

  const isActive = (path: string) => pathname === path

  if (!connected) return null

  return (
    <>
      {/* Desktop Navigation */}
      <div className="hidden md:block max-w-4xl mx-auto mb-2 z-50">
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
                <span>Reload your SOL</span>
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
                <span>Buy Tokens</span>
              </div>
            </Link>

            {isDevWallet(publicKey) && (
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
                  <span>Swap</span>
                </div>
              </Link>
            )}

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

      {/* Mobile Top Bar - SOL Balance & Info Tabs */}
      <div className="md:hidden max-w-4xl mx-auto mb-2 z-50 pt-2">
        <div className="flex items-center justify-between px-4 py-3 rounded-lg mb-4">
          {/* SOL Balance on Left */}
          <div className="flex-1">
            <WalletBalance />
          </div>
          
          {/* History & P&L on Right */}
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setActiveInfoTab(activeInfoTab === 'history' ? null : 'history')}
              className={`p-2 rounded-lg transition-all duration-200 ${
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
                className={`p-2 rounded-lg transition-all duration-200 ${
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
      </div>

      {/* Mobile Navigation - Bottom Fixed */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-black border-t border-gray-800 z-9999">
        <div className="flex items-center justify-around px-2 py-3">
          {/* Main Trading Tabs Only */}
          <Link
            href="/sell"
            className={`flex flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
              isActive('/sell')
                ? 'bg-white text-black'
                : 'text-gray-400'
            }`}
          >
            <svg className="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="text-xs font-medium">Reload</span>
          </Link>
          
          <Link
            href="/buy"
            className={`flex flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
              isActive('/buy')
                ? 'bg-white text-black'
                : 'text-gray-400'
            }`}
          >
            <svg className="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            <span className="text-xs font-medium">Buy</span>
          </Link>

          {isDevWallet(publicKey) && (
            <Link
              href="/swap"
              className={`flex flex-col items-center px-4 py-2 rounded-lg transition-all duration-200 ${
                isActive('/swap')
                  ? 'bg-white text-black'
                  : 'text-gray-400'
              }`}
            >
              <svg className="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              <span className="text-xs font-medium">Swap</span>
            </Link>
          )}
        </div>
      </div>
    </>
  )
}