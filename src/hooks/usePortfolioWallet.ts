'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatEther, formatUnits, type Address } from 'viem'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { useRhWalletMode } from '@/contexts/RhWalletModeContext'
import {
  useConnection,
  useWallet,
  useWalletAddress,
} from '@/components/WalletProvider'
import { useGmgnBoundWallets } from '@/hooks/useGmgnBoundWallets'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import { useWalletBalances } from '@/hooks/useWalletBalances'
import type { AppNetwork } from '@/utils/app-network'
import type { RhWalletMode } from '@/utils/rh-wallet-mode'
import { resolveRhActiveAddress } from '@/utils/rh-wallet-mode'
import {
  RH_USDG,
  RH_USDG_DECIMALS,
  RH_WETH,
  erc20Abi,
} from '@/utils/dlmm/rh-univ2'

export function rhEthBalanceQueryKey(address: string | null) {
  return ['rh-eth-balance', address] as const
}

export function rhUsdgBalanceQueryKey(address: string | null) {
  return ['rh-usdg-balance', address] as const
}

export function rhWethBalanceQueryKey(address: string | null) {
  return ['rh-weth-balance', address] as const
}

/** Native gas reserve kept when wrapping ETH→WETH (0.0005 ETH). */
export const RH_WETH_GAS_RESERVE_ETH = 0.0005

/** Active trading wallet for the current app network (+ RH parent/bound mode). */
export function usePortfolioWallet(): {
  network: AppNetwork
  walletAddress: string | null
  rhMode: RhWalletMode
  setRhMode: (m: RhWalletMode) => void
  parentAddress: string | null
  boundAddress: string | null
  connected: boolean
  nativeSymbol: 'SOL' | 'ETH'
  nativeBalance: number | null
  solBalance: number | null
  usdcBalance: number | null
  usdgBalance: number | null
  wethBalance: number | null
  refreshBalances: () => Promise<void>
  isLoadingBalances: boolean
} {
  const { network } = useAppNetwork()
  const { mode: rhMode, setMode: setRhMode } = useRhWalletMode()
  const solAddress = useWalletAddress()
  const { connected: solConnected, publicKey } = useWallet()
  const { connection } = useConnection()
  const rh = useRhEvmWallet()
  const bound = useGmgnBoundWallets()
  const queryClient = useQueryClient()

  const parentAddress = rh.address
  const boundAddress = bound.evm
  const walletAddress =
    network === 'robinhood'
      ? resolveRhActiveAddress(rhMode, parentAddress, boundAddress)
      : solAddress

  const isRh = network === 'robinhood'
  const connected = isRh ? Boolean(walletAddress) : solConnected
  const nativeSymbol = isRh ? 'ETH' : 'SOL'

  const solBalances = useWalletBalances({
    connection,
    publicKey,
    walletAddress: solAddress,
    enabled: !isRh && solConnected && !!publicKey,
  })

  const rhAddress = (walletAddress as Address | null) ?? null

  const ethQuery = useQuery({
    queryKey: rhEthBalanceQueryKey(rhAddress),
    enabled: isRh && Boolean(rhAddress),
    staleTime: 60_000,
    refetchInterval: isRh && rhAddress ? 60_000 : false,
    queryFn: async () => {
      if (!rhAddress) return null
      const wei = await rh.getPublicClient().getBalance({ address: rhAddress })
      return Number(formatEther(wei))
    },
  })

  const usdgQuery = useQuery({
    queryKey: rhUsdgBalanceQueryKey(rhAddress),
    enabled: isRh && Boolean(rhAddress),
    staleTime: 60_000,
    refetchInterval: isRh && rhAddress ? 60_000 : false,
    queryFn: async () => {
      if (!rhAddress) return null
      const raw = await rh.getPublicClient().readContract({
        address: RH_USDG,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [rhAddress],
      })
      return Number(formatUnits(raw, RH_USDG_DECIMALS))
    },
  })

  const wethQuery = useQuery({
    queryKey: rhWethBalanceQueryKey(rhAddress),
    enabled: isRh && Boolean(rhAddress),
    staleTime: 60_000,
    refetchInterval: isRh && rhAddress ? 60_000 : false,
    queryFn: async () => {
      if (!rhAddress) return null
      const raw = await rh.getPublicClient().readContract({
        address: RH_WETH,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [rhAddress],
      })
      return Number(formatUnits(raw, 18))
    },
  })

  const refreshBalances = async () => {
    if (isRh) {
      if (!rhAddress) return
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: rhEthBalanceQueryKey(rhAddress),
        }),
        queryClient.invalidateQueries({
          queryKey: rhUsdgBalanceQueryKey(rhAddress),
        }),
        queryClient.invalidateQueries({
          queryKey: rhWethBalanceQueryKey(rhAddress),
        }),
      ])
      return
    }
    await solBalances.refreshBalances()
  }

  const nativeBalance = isRh
    ? ethQuery.data ?? null
    : solBalances.walletBalance
  const solBalance = isRh ? null : solBalances.walletBalance
  const usdcBalance = isRh ? null : solBalances.usdcBalance
  const usdgBalance = isRh ? (usdgQuery.data ?? null) : null
  const wethBalance = isRh ? (wethQuery.data ?? null) : null
  const isLoadingBalances = isRh
    ? ethQuery.isPending || usdgQuery.isPending || wethQuery.isPending
    : solBalances.isLoadingBalances

  return {
    network,
    walletAddress,
    rhMode,
    setRhMode,
    parentAddress,
    boundAddress,
    connected,
    nativeSymbol,
    nativeBalance,
    solBalance,
    usdcBalance,
    usdgBalance,
    wethBalance,
    refreshBalances,
    isLoadingBalances,
  }
}
