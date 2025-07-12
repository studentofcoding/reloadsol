'use client'

import { useEffect, useRef } from 'react'
import { useWallet } from './WalletProvider'

interface JupiterTerminalProps {
  initialInputMint?: string
  initialOutputMint?: string
}

export default function JupiterTerminal({ 
  initialInputMint = 'So11111111111111111111111111111111111111112', // SOL
  initialOutputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
}: JupiterTerminalProps) {
  const walletContextState = useWallet()
  const terminalRef = useRef<HTMLDivElement>(null)

  // Initialize Jupiter Terminal
  useEffect(() => {

    if (typeof window !== "undefined" && window.Jupiter && window.Jupiter.init) {
      console.log('Initializing Jupiter Terminal with:', {
        initialInputMint,
        initialOutputMint,
        displayMode: "integrated"
      })
      window.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "jupiter-terminal-swap",
        containerClassName: "rounded-2xl p-6 w-full max-w-2xl mx-auto",
        enableWalletPassthrough: true,
        initialInputMint,
        initialOutputMint,
      })
    }
  }, [initialInputMint, initialOutputMint])

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
      <div id="jupiter-terminal-swap" ref={terminalRef} />
    </div>
  )
}