'use client'

import React, { useEffect } from 'react'
import { useWallet } from './WalletProvider'

// Jupiter Terminal integration component with wallet passthrough
export function JupiterTerminal() {
  const walletContextState = useWallet()

  // Initialize Jupiter Terminal
  useEffect(() => {
    if (typeof window !== "undefined" && window.Jupiter && window.Jupiter.init) {
      window.Jupiter.init({
        displayMode: "modal",
        integratedTargetId: "jupiter-terminal-swap",
        containerClassName: "rounded-2xl p-6 w-full max-w-2xl mx-auto",
        enableWalletPassthrough: true,
      })
    }
  }, [])

  // Sync wallet state with Jupiter Terminal
  useEffect(() => {
    if (typeof window !== "undefined" && window.Jupiter?.syncProps && walletContextState) {
      try {
        console.log('Syncing wallet state with Jupiter Terminal:', {
          connected: walletContextState.connected,
          publicKey: walletContextState.publicKey?.toString(),
          wallet: walletContextState.wallet
        })
        window.Jupiter.syncProps({ 
          passthroughWalletContextState: walletContextState 
        })
      } catch (error) {
        console.error('Failed to sync wallet state with Jupiter Terminal:', error)
      }
    } else {
      console.log('Jupiter Terminal sync conditions not met:', {
        hasWindow: typeof window !== "undefined",
        hasJupiter: !!window.Jupiter,
        hasSyncProps: !!window.Jupiter?.syncProps,
        hasWalletState: !!walletContextState
      })
    }
  }, [walletContextState])

  return (
    <div className="mx-auto border-none">
      <div id="jupiter-terminal-swap" />
    </div>
  )
}

export default JupiterTerminal