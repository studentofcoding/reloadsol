'use client'

import React, { useState } from 'react'
import { useWallet } from '@/components/WalletProvider'

export default function WalletSwitcher() {
  const { 
    connected, 
    walletType, 
    availableWallets, 
    preferredWallet,
    switchWallet, 
    connect,
    disconnect,
    connecting,
    disconnecting,
    mounted,
    hydrated
  } = useWallet()
  
  const [switching, setSwitching] = useState(false)

  // Prevent hydration mismatch by not rendering until fully hydrated
  if (!mounted || !hydrated) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
          <div className="animate-pulse">
            <div className="h-4 bg-gray-700 rounded w-3/4 mb-4"></div>
            <div className="h-10 bg-gray-700 rounded mb-2"></div>
            <div className="h-10 bg-gray-700 rounded"></div>
          </div>
        </div>
      </div>
    )
  }

  const handleWalletSwitch = async (type: 'phantom' | 'embedded') => {
    if (switching || connecting || disconnecting) return
    
    try {
      setSwitching(true)
      
      if (connected && walletType === type) {
        // Already connected to this wallet type
        return
      }
      
      if (connected) {
        // Switch to different wallet
        await switchWallet(type)
      } else {
        // Connect to specific wallet
        await connect(type)
      }
    } catch (error) {
      console.error('Failed to switch wallet:', error)
    } finally {
      setSwitching(false)
    }
  }

  const handleDisconnect = async () => {
    if (switching || connecting || disconnecting) return
    
    try {
      await disconnect()
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
  }

  // Show wallet options when both are available
  const showBothOptions = availableWallets.phantom && availableWallets.embedded

  if (connected) {
    return (
      <div className="max-w-md mx-auto">
        <div className="bg-gray-900 rounded-xl p-6 border border-gray-700">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-3">
              <div className={`w-3 h-3 rounded-full ${connected ? 'bg-green-400' : 'bg-gray-400'}`}></div>
              <span className="text-white font-medium">
                {walletType === 'phantom' ? 'Phantom Wallet' : 'Embedded Wallet'}
              </span>
            </div>
            <button
              onClick={handleDisconnect}
              disabled={disconnecting || switching}
              className="text-gray-400 hover:text-red-400 text-sm disabled:opacity-50"
            >
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </button>
          </div>
          
          {showBothOptions && (
            <div className="space-y-2">
              <p className="text-gray-400 text-sm mb-3">Switch to:</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleWalletSwitch('phantom')}
                  disabled={walletType === 'phantom' || switching || connecting || disconnecting}
                  className={`p-3 rounded-lg border text-sm font-medium transition-all ${
                    walletType === 'phantom'
                      ? 'border-purple-500 bg-purple-500/10 text-purple-400 cursor-not-allowed'
                      : 'border-gray-600 hover:border-purple-500 text-gray-300 hover:text-white'
                  } disabled:opacity-50`}
                >
                  {switching && walletType !== 'phantom' ? 'Switching...' : 'Phantom'}
                </button>
                <button
                  onClick={() => handleWalletSwitch('embedded')}
                  disabled={walletType === 'embedded' || switching || connecting || disconnecting}
                  className={`p-3 rounded-lg border text-sm font-medium transition-all ${
                    walletType === 'embedded'
                      ? 'border-blue-500 bg-blue-500/10 text-blue-400 cursor-not-allowed'
                      : 'border-gray-600 hover:border-blue-500 text-gray-300 hover:text-white'
                  } disabled:opacity-50`}
                >
                  {switching && walletType !== 'embedded' ? 'Switching...' : 'Embedded'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Not connected - show available wallet options
  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-white mb-2">Choose Your Wallet</h2>
        <p className="text-gray-400">
          {showBothOptions 
            ? 'You have multiple wallets available. Choose your preferred option:'
            : 'Select how you\'d like to connect and start trading'
          }
        </p>
        {preferredWallet && (
          <p className="text-sm text-gray-500 mt-2">
            Previously used: {preferredWallet === 'phantom' ? 'Phantom' : 'Embedded'} wallet
          </p>
        )}
      </div>

      <div className={`grid gap-6 ${showBothOptions ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 max-w-md mx-auto'}`}>
        {/* Phantom Wallet Option */}
        {availableWallets.phantom && (
          <div 
            onClick={() => handleWalletSwitch('phantom')}
            className={`bg-gray-900 rounded-xl p-6 border border-gray-700 hover:border-purple-500 cursor-pointer transition-all duration-200 hover:bg-gray-800 ${
              preferredWallet === 'phantom' ? 'ring-2 ring-purple-500/50' : ''
            }`}
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
            {preferredWallet === 'phantom' && (
              <div className="mt-3 text-center">
                <span className="text-xs text-purple-400 bg-purple-500/10 px-2 py-1 rounded">
                  Preferred
                </span>
              </div>
            )}
          </div>
        )}

        {/* Embedded Wallet Option */}
        {availableWallets.embedded && (
          <div 
            onClick={() => handleWalletSwitch('embedded')}
            className={`bg-gray-900 rounded-xl p-6 border border-gray-700 hover:border-blue-500 cursor-pointer transition-all duration-200 hover:bg-gray-800 ${
              preferredWallet === 'embedded' ? 'ring-2 ring-blue-500/50' : ''
            }`}
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
              Use your managed wallet. Perfect for automated trading with no manual approvals.
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
            {preferredWallet === 'embedded' && (
              <div className="mt-3 text-center">
                <span className="text-xs text-blue-400 bg-blue-500/10 px-2 py-1 rounded">
                  Preferred
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {showBothOptions && (
        <div className="text-center mt-6">
          <p className="text-xs text-gray-500">
            Your choice will be remembered for future visits. You can always switch later.
          </p>
        </div>
      )}

      {connecting && (
        <div className="text-center mt-4">
          <p className="text-gray-400">Connecting...</p>
        </div>
      )}
    </div>
  )
}