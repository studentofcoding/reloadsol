'use client'

import React from 'react'
import { useWallet } from './WalletProvider'

export default function PhantomWalletButton() {
  const { publicKey, connected, connecting, connect, disconnect } = useWallet()

  if (connected && publicKey) {
    return (
      <div className="flex items-center space-x-3">
        <div className="bg-white text-black rounded-lg px-4 py-2 font-medium border border-gray-300">
          <div className="text-sm opacity-70">Connected to Phantom</div>
          <div className="text-xs font-mono">
            {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
          </div>
        </div>
        <button
          onClick={disconnect}
          className="bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium transition-colors border border-gray-600"
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={connect}
      disabled={connecting}
      className={`
        flex items-center space-x-2 px-6 py-3 rounded-lg font-semibold transition-all duration-200 border
        ${connecting 
          ? 'bg-gray-600 text-gray-400 cursor-not-allowed border-gray-500' 
          : 'bg-white hover:bg-gray-100 text-black border-gray-300 shadow-lg hover:shadow-xl'
        }
      `}
    >
      {connecting ? (
        <>
          <div className="w-5 h-5 border-2 border-gray-400 border-t-black rounded-full animate-spin"></div>
          <span>Connecting...</span>
        </>
      ) : (
        <>
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z"/>
          </svg>
          <span>Connect Phantom</span>
        </>
      )}
    </button>
  )
} 