'use client'

import { useQuery } from '@tanstack/react-query'
import { formatEther } from 'viem'
import { useGmgnBoundWallets } from '@/hooks/useGmgnBoundWallets'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'

/** ETH balance for Robinhood network nav chrome. */
export default function RhWalletBalance() {
  const rh = useRhEvmWallet()
  const bound = useGmgnBoundWallets()
  const address = rh.address ?? (bound.evm as `0x${string}` | null)

  const { data: ethUi, isLoading } = useQuery({
    queryKey: ['rh-eth-balance', address],
    enabled: Boolean(address),
    staleTime: 15_000,
    queryFn: async () => {
      if (!address) return null
      const wei = await rh.publicClient.getBalance({ address })
      return Number(formatEther(wei))
    },
  })

  if (!address) {
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

  const label =
    ethUi != null
      ? `${ethUi < 0.0001 ? ethUi.toExponential(2) : ethUi.toFixed(4)} ETH`
      : isLoading
        ? '… ETH'
        : '— ETH'

  return (
    <div
      className="text-sm font-medium text-white px-2 py-1 font-mono"
      title={address}
    >
      {label}
    </div>
  )
}
