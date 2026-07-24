'use client'

import { usePortfolioWallet } from '@/hooks/usePortfolioWallet'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'

/** ETH balance for Robinhood network nav chrome (active parent/bound address). */
export default function RhWalletBalance() {
  const rh = useRhEvmWallet()
  const {
    walletAddress,
    rhMode,
    nativeBalance,
    isLoadingBalances,
  } = usePortfolioWallet()

  if (!walletAddress) {
    if (rhMode === 'bound') {
      return (
        <span className="text-sm text-gray-400 px-2 py-1">No bound EVM</span>
      )
    }
    return (
      <button
        type="button"
        onClick={() => void rh.connect()}
        className="text-sm text-gray-400 hover:text-white px-2 py-1"
      >
        {rh.connecting ? 'Connecting…' : 'Connect Rabby'}
      </button>
    )
  }

  const ethUi = nativeBalance
  const label =
    ethUi != null
      ? `${ethUi < 0.0001 ? ethUi.toExponential(2) : ethUi.toFixed(4)} ETH`
      : isLoadingBalances
        ? '… ETH'
        : '— ETH'

  return (
    <div
      className="text-sm font-medium text-white px-2 py-1 font-mono"
      title={`${rhMode}: ${walletAddress}`}
    >
      {label}
    </div>
  )
}
