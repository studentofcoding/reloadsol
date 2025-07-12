'use client'

import React from 'react'
import ConnectionStatus from '@/components/ConnectionStatus'
import TradingHistory from '@/components/TradingHistory'
import PnLTracker from '@/components/PnLTracker'
import Footer from '@/components/Footer'
import NavigationTabs from '@/components/NavigationTabs'
import { useWallet } from '@/components/WalletProvider'
import { isDevWallet } from '@/utils/dev-wallet'
import { useState } from 'react'

export default function TradeLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { connected, publicKey } = useWallet()
  const [activeInfoTab, setActiveInfoTab] = useState<'history' | 'pnl' | null>('history')

  return (
    <main className="min-h-screen bg-black py-8 pb-24 md:pb-8">
      <div className="container mx-auto px-4">
        {/* Header */}
        <div className="text-center mb-8 sm:mb-12">
          <h1 className="text-5xl font-bold text-white mb-4">
            reloadSOL
          </h1>
          {!connected && (
          <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
            Reload your Solana from all worthless memecoins, and trade smartly with us!
            <br />
            Powered by <img className="inline-block h-[1.25rem]" src="https://s3.coinmarketcap.com/static-gravity/image/4dc5810324c74688a5a1b805f7506ec5.jpg" alt="Jupiter Logo" /> Jupiter, <img className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1902372646249234432/T4kNyTq0_400x400.jpg" alt="Superteam Logo" /> Superteam Indonesia and 
            a part of <img className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1843973608378421248/CzmuKtDx_400x400.jpg" alt="Colosseum Breakout" />.
          </h2>
          )}
          
          {connected && (
            <div className="mt-8 flex items-center justify-center space-x-4">
              <ConnectionStatus />
            </div>
          )}
        </div>
        
        {/* Navigation Tabs */}
        <NavigationTabs 
          activeInfoTab={activeInfoTab} 
          setActiveInfoTab={setActiveInfoTab} 
        />

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
        
        <div className="max-w-4xl mx-auto min-h-[300px]">
        {children}
        </div>
      </div>
      
      <Footer />
    </main>
  )
}