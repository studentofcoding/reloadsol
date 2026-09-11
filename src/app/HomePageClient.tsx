'use client'

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useEffect, useRef } from 'react'
import LastReloadTracker from '@/components/LastReloadTracker'
import WalletChooser from '@/components/WalletChooser'
import Footer from '@/components/Footer'
import ReloadHome from '@/components/reload/ReloadHome'
import { useWallet } from '@/components/WalletProvider'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'

function HomeContent() {
  const { connected } = useWallet()
  const rh = useRhEvmWallet()
  const { setNetwork } = useAppNetwork()
  const solConnectedRef = useRef(false)
  const rhConnectedRef = useRef(false)
  const rhConnected = Boolean(rh.address)
  const showReload = connected || rhConnected

  useEffect(() => {
    const solJustConnected = connected && !solConnectedRef.current
    const rhJustConnected = rhConnected && !rhConnectedRef.current
    solConnectedRef.current = connected
    rhConnectedRef.current = rhConnected

    if (solJustConnected) {
      setNetwork('sol')
      return
    }
    if (rhJustConnected) {
      setNetwork('robinhood', { skipCoerce: true })
    }
  }, [connected, rhConnected, setNetwork])

  return (
    <div className="min-h-screen bg-black py-8">
      <div className="container mx-auto px-4">
        <div className="text-center mb-8">
          <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
            Reload your Solana from all worthless memecoins, and trade smartly with us!
            <br />
            Powered by <OptimizedImage className="inline-block h-[1.25rem]" src="https://s3.coinmarketcap.com/static-gravity/image/4dc5810324c74688a5a1b805f7506ec5.jpg" alt="Jupiter Logo" /> Jupiter, <OptimizedImage className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1902372646249234432/T4kNyTq0_400x400.jpg" alt="Superteam Logo" /> Superteam Indonesia and
            a part of <OptimizedImage className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1843973608378421248/CzmuKtDx_400x400.jpg" alt="Colosseum Breakout" />.
          </h2>
        </div>

        <WalletChooser />

        {showReload ? (
          <div className="mt-8">
            <div className="mb-6 max-w-md mx-auto">
              <LastReloadTracker />
            </div>
            <ReloadHome />
          </div>
        ) : (
          <div className="mt-8 max-w-md mx-auto">
            <LastReloadTracker />
          </div>
        )}
      </div>
      <Footer />
    </div>
  )
}

export default function HomePageClient() {
  return <HomeContent />
}
