'use client'

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import LastReloadTracker from '@/components/LastReloadTracker'
import UniversalWalletButton from '@/components/UniversalWalletButton'
import Footer from '@/components/Footer'
import { useWallet } from '@/components/WalletProvider'
import WelcomeModal from '@/components/WelcomeModal'

function HomeContent() {
  const [showWelcome, setShowWelcome] = useState(false)
  const { connected } = useWallet()
  const router = useRouter()
  const hasRedirectedRef = useRef(false)

  // Auto-redirect connected users to sell page, but only once per session
  useEffect(() => {
    if (hasRedirectedRef.current) return

    const hasDisconnected = sessionStorage.getItem('hasDisconnected')
    const justDisconnected = sessionStorage.getItem('justDisconnected')
    if (justDisconnected) {
      sessionStorage.removeItem('justDisconnected')
      return
    }

    if (connected && !hasDisconnected) {
      hasRedirectedRef.current = true
      router.replace('/sell')
    }
  }, [connected, router])

  // Check if user should see welcome modal (only for non-connected users on landing)
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

  const handleCloseWelcome = () => {
    setShowWelcome(false)
    localStorage.setItem('buyBulkWelcomeSeen', 'true')
  }

  return (
    <>
      {/* Removed Header component */}
      <div className="min-h-screen bg-black py-8">
        <div className="container mx-auto px-4">
          <div className="text-center mb-8">
            <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
              Reload your Solana from all worthless memecoins, and trade smartly with us!
              <br />
              Powered by <OptimizedImage className="inline-block h-[1.25rem]" src="https://s3.coinmarketcap.com/static-gravity/image/4dc5810324c74688a5a1b805f7506ec5.jpg" alt="Jupiter Logo" /> Jupiter, <OptimizedImage className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1902372646249234432/T4kNyTq0_400x400.jpg" alt="Superteam Logo" /> Superteam Indonesia and 
              a part of <OptimizedImage className="inline-block h-[1.25rem]" src="https://pbs.twimg.com/profile_images/1843973608378421248/CzmuKtDx_400x400.jpg" alt="Colosseum Breakout" />.
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

          {/* Get Started Section */}
          {!connected && (
          <div className="max-w-4xl mx-auto mb-10 text-center">
            <UniversalWalletButton />
          </div>
          )}

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
      </div>

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
  return <HomeContent />
}