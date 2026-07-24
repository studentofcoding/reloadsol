'use client'

import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { useRhWalletMode } from '@/contexts/RhWalletModeContext'
import { useWalletAddress } from '@/components/WalletProvider'
import { useGmgnBoundWallets } from '@/hooks/useGmgnBoundWallets'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import type { AppNetwork } from '@/utils/app-network'
import type { RhWalletMode } from '@/utils/rh-wallet-mode'
import { resolveRhActiveAddress } from '@/utils/rh-wallet-mode'

/** Active trading wallet for the current app network (+ RH parent/bound mode). */
export function usePortfolioWallet(): {
  network: AppNetwork
  walletAddress: string | null
  rhMode: RhWalletMode
  setRhMode: (m: RhWalletMode) => void
  parentAddress: string | null
  boundAddress: string | null
} {
  const { network } = useAppNetwork()
  const { mode: rhMode, setMode: setRhMode } = useRhWalletMode()
  const sol = useWalletAddress()
  const rh = useRhEvmWallet()
  const bound = useGmgnBoundWallets()
  const parentAddress = rh.address
  const boundAddress = bound.evm
  const walletAddress =
    network === 'robinhood'
      ? resolveRhActiveAddress(rhMode, parentAddress, boundAddress)
      : sol
  return {
    network,
    walletAddress,
    rhMode,
    setRhMode,
    parentAddress,
    boundAddress,
  }
}
