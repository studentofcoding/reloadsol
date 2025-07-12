'use client'

import JupiterTerminal from '@/components/JupiterTerminal'
import { WalletProvider } from '@/components/WalletProvider'

export default function SwapPageClient() {
  // Fixed trading pair: SOL -> USDC
  const inputMint = 'So11111111111111111111111111111111111111112' // SOL
  const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
  
  return (
    <div className="flex flex-col items-center justify-center">
      <WalletProvider>
        <JupiterTerminal 
          initialInputMint={inputMint}
          initialOutputMint={outputMint}
        />
      </WalletProvider>
    </div>
  )
}