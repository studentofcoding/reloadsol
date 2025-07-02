'use client'

import React from 'react'
import PhantomWalletButton from '@/components/PhantomWalletButton'
import { useWallet } from '@/components/WalletProvider'

export default function SwapPageClient() {
  const { connected } = useWallet()

  return (
    <div className="bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-8 space-y-8">
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white mb-4">Token Swap</h2>
        <p className="text-gray-400 mb-8">
          Individual token swap functionality coming soon!
        </p>
        
        {!connected ? (
          <div className="space-y-4">
            <p className="text-gray-300">Connect your wallet to get started</p>
            <PhantomWalletButton />
          </div>
        ) : (
          <div className="bg-gray-800 border border-gray-600 rounded-xl p-6">
            <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Coming Soon</h3>
            <p className="text-gray-400 mb-4">
              Individual token swap feature is in development. For now, use our bulk buy and sell features.
            </p>
            <div className="flex gap-4 justify-center">
              <a href="/buy" className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors">
                Buy Tokens
              </a>
              <a href="/sell" className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors">
                Reload SOL
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
} 