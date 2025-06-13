'use client'

import React, { useState } from 'react'
import BulkTokenBuyer from '@/components/BulkTokenBuyer'
import BulkTokenSeller from '@/components/BulkTokenSeller'
import WalletBalance from '@/components/WalletBalance'
import { useWallet } from '@/components/WalletProvider'

export default function Home() {
  const [activeTab, setActiveTab] = useState<'buy' | 'sell'>('buy')
  const { connected } = useWallet()

  return (
    <main className="min-h-screen bg-black py-8">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h1 className="text-5xl font-bold text-white mb-4">
            reloadSOL
          </h1>
          <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
            Reload your Solana from all worthless memecoins, and trade smartly with us!
            <br />
            Powered by <img className="inline-block h-[1.25rem]" src="https://s3.coinmarketcap.com/static-gravity/image/4dc5810324c74688a5a1b805f7506ec5.jpg" alt="Jupiter Logo" /> Jupiter, <img className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1902372646249234432/T4kNyTq0_400x400.jpg" alt="Superteam Logo" /> Superteam Indonesia and 
            a part of <img className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1843973608378421248/CzmuKtDx_400x400.jpg" alt="Colosseum Breakout" />.
          </h2>
          <div className="mt-6 flex items-center justify-center space-x-6 text-sm text-gray-500">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
              <span>Global Jupiter Integration</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
              <span>1 click mode</span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
              <span>Auto Account Closing</span>
            </div>
          </div>
        </div>
        
        {/* Tab Navigation */}
        <div className="max-w-4xl mx-auto mb-8">
          <div className="flex items-center justify-between h-full">
            <div>
              <button
                onClick={() => setActiveTab('buy')}
                className={`px-6 py-3 rounded-lg font-semibold transition-all duration-200 ${
                  activeTab === 'buy'
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
              </button>
              <button
                onClick={() => setActiveTab('sell')}
                className={`px-6 py-3 ml-2 rounded-lg font-semibold transition-all duration-200 ${
                  activeTab === 'sell'
                    ? 'bg-white text-black'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                <div className="flex items-center space-x-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4m16 0l-4-4m4 4l-4 4" />
                  </svg>
                  <span>Sell Tokens</span>
                </div>
              </button>
            </div>

            {/* Wallet Balance Display */}
            {connected && (
              <div className="h-full">
                <WalletBalance />
              </div>
            )}
          </div>
        </div>

        {/* Tab Content */}
        <div className="max-w-4xl mx-auto">
          <div>
            {activeTab === 'buy' ? (
              <BulkTokenBuyer />
            ) : (
              <BulkTokenSeller />
            )}
          </div>
        </div>

        {/* Feature Cards */}
        {!connected && (
          <div className="max-w-4xl mx-auto mt-16">
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
        )}
      </div>
    </main>
  )
} 