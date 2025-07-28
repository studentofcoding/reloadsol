'use client'

import React, { useState } from 'react'
import { useWallet } from './WalletProvider'

export default function EmbeddedWalletButton() {
  const [email, setEmail] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')
  const { connected, publicKey, disconnect } = useWallet()

  // If already connected to embedded wallet, show disconnect option
  if (connected && publicKey) {
    return (
      <div className="text-center">
        <div className="bg-gray-800 rounded-lg p-4 mb-4">
          <div className="flex items-center justify-center mb-2">
            <div className="w-3 h-3 bg-green-400 rounded-full mr-2"></div>
            <span className="text-green-400 text-sm font-medium">Embedded Wallet Connected</span>
          </div>
          <p className="text-gray-400 text-xs">
            {publicKey.toString().slice(0, 8)}...{publicKey.toString().slice(-8)}
          </p>
        </div>
        <button
          onClick={async () => {
            await disconnect()
            window.location.href = '/'
          }}
          className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors w-full"
        >
          Disconnect Wallet
        </button>
      </div>
    )
  }

  const handleCreateWallet = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!email.trim()) {
      setError('Email is required')
      return
    }

    if (!email.includes('@')) {
      setError('Please enter a valid email address')
      return
    }

    setIsCreating(true)
    setError('')

    try {
      const response = await fetch('/api/embedded-wallet/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: email.trim() }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create wallet')
      }

      if (data.success) {
        // Store wallet info in localStorage for the wallet provider
        localStorage.setItem('embeddedWallet', JSON.stringify({
          type: 'embedded',
          publicKey: data.wallet.wallet_address,
          email: data.wallet.email,
          crossmintWalletId: data.wallet.crossmint_wallet_id,
          userId: data.wallet.user_id
        }))

        // Trigger a page reload to let WalletProvider pick up the embedded wallet
        window.location.reload()
      }
    } catch (error: any) {
      console.error('Error creating embedded wallet:', error)
      setError(error.message || 'Failed to create wallet. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <form onSubmit={handleCreateWallet} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-2">
          Email Address
        </label>
        <input
          type="email"
          id="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your email address"
          className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          disabled={isCreating}
        />
      </div>

      {error && (
        <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded-lg p-3">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={isCreating || !email.trim()}
        className={`
          w-full flex items-center justify-center space-x-2 px-4 py-3 rounded-lg font-semibold transition-all duration-200
          ${isCreating || !email.trim()
            ? 'bg-gray-600 text-gray-400 cursor-not-allowed' 
            : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg hover:shadow-xl'
          }
        `}
      >
        {isCreating ? (
          <>
            <div className="w-5 h-5 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
            <span>Creating Wallet...</span>
          </>
        ) : (
          <>
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>Create Embedded Wallet</span>
          </>
        )}
      </button>

      <div className="text-xs text-gray-500 text-center">
        <p>By creating an embedded wallet, you agree to have your wallet managed by Crossmint.</p>
        <p className="mt-1">This enables automatic transaction signing for seamless trading.</p>
      </div>
    </form>
  )
}