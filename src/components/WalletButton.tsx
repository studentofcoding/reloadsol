'use client'

import React from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { useWallet } from './WalletProvider'

export default function WalletButton() {
  const { login, logout, ready, authenticated } = usePrivy()
  const { publicKey, connected } = useWallet()

  if (connected && publicKey) {
    return (
      <div className="flex items-center space-x-3">
        <button
          onClick={async () => {
            await logout()
            window.location.href = '/'
          }}
          className="bg-black hover:bg-gray-800 text-white px-4 py-2 rounded-lg font-medium transition-colors border border-gray-600"
        >
          <span className="hidden md:inline">Disconnect</span>
          <svg className="w-5 h-5 md:hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => login({
        loginMethods: ['wallet'],
        walletChainType: 'solana-only',
        disableSignup: false
      })}
      disabled={!ready}
      className={`
        flex items-center justify-center space-x-2 px-3 py-3 rounded-lg font-semibold transition-all duration-200 border mx-auto
        ${!ready 
          ? 'bg-gray-600 text-gray-400 cursor-not-allowed border-gray-500' 
          : 'bg-white hover:bg-gray-100 text-black border-gray-300 shadow-lg hover:shadow-xl'
        }
      `}
    >
      {!ready ? (
        <>
          <div className="w-5 h-5 border-2 border-gray-400 border-t-black rounded-full animate-spin"></div>
          <span>Loading...</span>
        </>
      ) : (
        <>
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L2 7v10c0 5.55 3.84 9.74 9 11 5.16-1.26 9-5.45 9-11V7l-10-5z"/>
          </svg>
          <span>Connect Wallet</span>
        </>
      )}
    </button>
  )
}