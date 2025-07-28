'use client'

import React, { useState } from 'react'
import PhantomWalletButton from '@/components/PhantomWalletButton'
import EmbeddedWalletButton from '@/components/EmbeddedWalletButton'

interface WalletSelectionProps {
  onWalletTypeSelected?: (type: 'phantom' | 'embedded') => void
}

export default function WalletSelection({ onWalletTypeSelected }: WalletSelectionProps) {
  const [selectedWalletType, setSelectedWalletType] = useState<'phantom' | 'embedded' | null>(null)
  const [showEmailInput, setShowEmailInput] = useState(false)

  const handleWalletTypeSelect = (type: 'phantom' | 'embedded') => {
    setSelectedWalletType(type)
    onWalletTypeSelected?.(type)
    
    if (type === 'embedded') {
      setShowEmailInput(true)
    }
  }

  const handleBackToSelection = () => {
    setSelectedWalletType(null)
    setShowEmailInput(false)
  }

  if (selectedWalletType === 'phantom') {
    return (
      <div className="max-w-md mx-auto">
        <div className="text-center mb-4">
          <button
            onClick={handleBackToSelection}
            className="text-gray-400 hover:text-white text-sm flex items-center justify-center mx-auto mb-2"
          >
            ← Back to wallet selection
          </button>
          <h3 className="text-lg font-semibold text-white mb-2">Connect Phantom Wallet</h3>
          <p className="text-gray-400 text-sm">Connect your existing Phantom wallet to start trading</p>
        </div>
        <PhantomWalletButton />
      </div>
    )
  }

  if (selectedWalletType === 'embedded') {
    return (
      <div className="max-w-md mx-auto">
        <div className="text-center mb-4">
          <button
            onClick={handleBackToSelection}
            className="text-gray-400 hover:text-white text-sm flex items-center justify-center mx-auto mb-2"
          >
            ← Back to wallet selection
          </button>
          <h3 className="text-lg font-semibold text-white mb-2">Create Embedded Wallet</h3>
          <p className="text-gray-400 text-sm">Create a new wallet that's managed for you - no extensions needed</p>
        </div>
        <EmbeddedWalletButton />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-white mb-2">Choose Your Wallet</h2>
        <p className="text-gray-400">Select how you'd like to connect and start trading</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Phantom Wallet Option */}
        <div 
          onClick={() => handleWalletTypeSelect('phantom')}
          className="bg-gray-900 rounded-xl p-6 border border-gray-700 hover:border-purple-500 cursor-pointer transition-all duration-200 hover:bg-gray-800"
        >
          <div className="flex items-center justify-center mb-4">
            <div className="w-16 h-16 bg-purple-600 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z"/>
              </svg>
            </div>
          </div>
          <h3 className="text-xl font-semibold text-white mb-2 text-center">Phantom Wallet</h3>
          <p className="text-gray-400 text-sm text-center mb-4">
            Connect your existing Phantom wallet. You'll need to approve each transaction.
          </p>
          <div className="space-y-2 text-xs text-gray-500">
            <div className="flex items-center">
              <span className="text-green-400 mr-2">✓</span>
              <span>Full control of your keys</span>
            </div>
            <div className="flex items-center">
              <span className="text-green-400 mr-2">✓</span>
              <span>Use existing wallet</span>
            </div>
            <div className="flex items-center">
              <span className="text-yellow-400 mr-2">⚠</span>
              <span>Manual transaction approval</span>
            </div>
          </div>
        </div>

        {/* Embedded Wallet Option */}
        <div 
          onClick={() => handleWalletTypeSelect('embedded')}
          className="bg-gray-900 rounded-xl p-6 border border-gray-700 hover:border-blue-500 cursor-pointer transition-all duration-200 hover:bg-gray-800"
        >
          <div className="flex items-center justify-center mb-4">
            <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
          </div>
          <h3 className="text-xl font-semibold text-white mb-2 text-center">Embedded Wallet</h3>
          <p className="text-gray-400 text-sm text-center mb-4">
            Create a new managed wallet. Perfect for automated trading with no manual approvals.
          </p>
          <div className="space-y-2 text-xs text-gray-500">
            <div className="flex items-center">
              <span className="text-green-400 mr-2">✓</span>
              <span>Auto-signing transactions</span>
            </div>
            <div className="flex items-center">
              <span className="text-green-400 mr-2">✓</span>
              <span>No browser extension needed</span>
            </div>
            <div className="flex items-center">
              <span className="text-blue-400 mr-2">ℹ</span>
              <span>Managed by Crossmint</span>
            </div>
          </div>
        </div>
      </div>

      <div className="text-center mt-6">
        <p className="text-xs text-gray-500">
          Both options are secure. Choose based on your trading style and preferences.
        </p>
      </div>
    </div>
  )
}