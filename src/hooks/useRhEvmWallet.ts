'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { RH_CHAIN, RH_CHAIN_ID, getRhRpcUrl } from '@/utils/dlmm/rh-univ2'

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

function getEthereum(): EthereumProvider | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { ethereum?: EthereumProvider }).ethereum
}

function rhChainParams() {
  return {
    chainId: `0x${RH_CHAIN_ID.toString(16)}`,
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [getRhRpcUrl()],
    blockExplorerUrls: [RH_CHAIN.blockExplorers.default.url],
  }
}

export function useRhEvmWallet() {
  const [address, setAddress] = useState<Address | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const refresh = useCallback(async () => {
    const eth = getEthereum()
    if (!eth) return
    try {
      const [accounts, cid] = await Promise.all([
        eth.request({ method: 'eth_accounts' }) as Promise<string[]>,
        eth.request({ method: 'eth_chainId' }) as Promise<string>,
      ])
      setAddress((accounts?.[0] as Address | undefined) ?? null)
      setChainId(cid ? Number.parseInt(cid, 16) : null)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    const eth = getEthereum()
    if (!eth) return
    // Defer: avoid sync setState-in-effect on mount (external wallet sync).
    queueMicrotask(() => {
      void refresh()
    })
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined
      setAddress((accounts?.[0] as Address | undefined) ?? null)
    }
    const onChain = (...args: unknown[]) => {
      const cid = args[0] as string | undefined
      setChainId(cid ? Number.parseInt(cid, 16) : null)
    }
    eth.on?.('accountsChanged', onAccounts)
    eth.on?.('chainChanged', onChain)
    return () => {
      eth.removeListener?.('accountsChanged', onAccounts)
      eth.removeListener?.('chainChanged', onChain)
    }
  }, [refresh])

  const ensureChain = useCallback(async () => {
    const eth = getEthereum()
    if (!eth) throw new Error('No injected wallet (install MetaMask / Rabby)')
    const params = rhChainParams()
    const cid = (await eth.request({ method: 'eth_chainId' })) as string
    if (Number.parseInt(cid, 16) === RH_CHAIN_ID) return
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: params.chainId }],
      })
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? Number((err as { code: number }).code)
          : 0
      if (code === 4902) {
        await eth.request({
          method: 'wallet_addEthereumChain',
          params: [params],
        })
        return
      }
      throw err
    }
  }, [])

  const connect = useCallback(async () => {
    setConnecting(true)
    setError(null)
    try {
      const eth = getEthereum()
      if (!eth) throw new Error('No injected wallet (install MetaMask / Rabby)')
      const accounts = (await eth.request({
        method: 'eth_requestAccounts',
      })) as string[]
      await ensureChain()
      setAddress((accounts?.[0] as Address | undefined) ?? null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connect failed')
      throw err
    } finally {
      setConnecting(false)
    }
  }, [ensureChain, refresh])

  const publicClient: PublicClient = useMemo(
    () =>
      createPublicClient({
        chain: RH_CHAIN,
        transport: http(getRhRpcUrl()),
      }),
    [],
  )

  const getWalletClient = useCallback(async (): Promise<WalletClient> => {
    const eth = getEthereum()
    if (!eth) throw new Error('No injected wallet')
    await ensureChain()
    const accounts = (await eth.request({
      method: 'eth_requestAccounts',
    })) as string[]
    const account = accounts[0] as Address | undefined
    if (!account) throw new Error('Wallet not connected')
    setAddress(account)
    return createWalletClient({
      account,
      chain: RH_CHAIN,
      transport: custom(eth),
    })
  }, [ensureChain])

  return {
    address,
    chainId,
    isCorrectChain: chainId === RH_CHAIN_ID,
    hasProvider: Boolean(getEthereum()),
    connecting,
    error,
    connect,
    ensureChain,
    refresh,
    publicClient,
    getWalletClient,
  }
}
