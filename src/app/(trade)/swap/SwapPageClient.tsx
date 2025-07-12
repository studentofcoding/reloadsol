'use client'

import JupiterTerminal from '@/components/JupiterTerminal'
import { WalletProvider } from '@/components/WalletProvider'

export default function SwapPageClient() {
  return (
    <div className="flex flex-col items-center justify-center">
      <WalletProvider>
        <JupiterTerminal />
      </WalletProvider>
    </div>
  )
} 