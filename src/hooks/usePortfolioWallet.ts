'use client'

import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { useWalletAddress } from '@/components/WalletProvider'
import { useGmgnBoundWallets } from '@/hooks/useGmgnBoundWallets'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import type { AppNetwork } from '@/utils/app-network'

/** Active trading wallet for the current app network. */
export function usePortfolioWallet(): {
  network: AppNetwork
  walletAddress: string | null
} {
  const { network } = useAppNetwork()
  const sol = useWalletAddress()
  const rh = useRhEvmWallet()
  const bound = useGmgnBoundWallets()
  const walletAddress =
    network === 'robinhood' ? rh.address ?? bound.evm : sol
  return { network, walletAddress }
}
