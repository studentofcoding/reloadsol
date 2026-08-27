'use client'

import { useCallback, useEffect, useState } from 'react'
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

type Eip6963ProviderDetail = {
  info: { uuid: string; name: string; rdns?: string; icon?: string }
  provider: EthereumProvider
}

let cachedProvider: EthereumProvider | undefined
let eip6963Providers: Eip6963ProviderDetail[] = []
let listening6963 = false

function isRabby(detail: Eip6963ProviderDetail): boolean {
  const rdns = (detail.info.rdns ?? '').toLowerCase()
  const name = detail.info.name.toLowerCase()
  return rdns.includes('rabby') || name.includes('rabby')
}

function ensureEip6963Listeners() {
  if (typeof window === 'undefined' || listening6963) return
  listening6963 = true
  window.addEventListener('eip6963:announceProvider', ((event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail
    if (!detail?.provider || !detail.info?.uuid) return
    if (eip6963Providers.some((p) => p.info.uuid === detail.info.uuid)) return
    eip6963Providers.push(detail)
    cachedProvider = undefined
  }) as EventListener)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
}

/** Prefer Rabby via EIP-6963; fall back to window.ethereum. */
export function getEthereumProvider(): EthereumProvider | undefined {
  if (typeof window === 'undefined') return undefined
  ensureEip6963Listeners()
  if (cachedProvider) return cachedProvider

  const rabby = eip6963Providers.find(isRabby)
  if (rabby) {
    cachedProvider = rabby.provider
    return cachedProvider
  }
  if (eip6963Providers.length === 1) {
    cachedProvider = eip6963Providers[0]!.provider
    return cachedProvider
  }

  const eth = (window as Window & { ethereum?: EthereumProvider }).ethereum
  if (eth) {
    cachedProvider = eth
    return cachedProvider
  }
  return undefined
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
  const [hasProvider, setHasProvider] = useState(() =>
    typeof window !== 'undefined' ? Boolean(getEthereumProvider()) : false,
  )

  const refresh = useCallback(async () => {
    const eth = getEthereumProvider()
    setHasProvider(Boolean(eth))
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
    ensureEip6963Listeners()
    const eth = getEthereumProvider()
    if (!eth) {
      // Late announce (Rabby after hydrate) — refresh updates hasProvider
      const t = window.setTimeout(() => {
        void refresh()
      }, 300)
      return () => window.clearTimeout(t)
    }
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
    const eth = getEthereumProvider()
    if (!eth) throw new Error('No Rabby (or EVM wallet) — install Rabby')
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
      // Re-request announce in case Rabby loaded late
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('eip6963:requestProvider'))
      }
      const eth = getEthereumProvider()
      if (!eth) throw new Error('No Rabby (or EVM wallet) — install Rabby')
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

  const disconnect = useCallback(async () => {
    setError(null)
    const eth = getEthereumProvider()
    // EIP-1193 has no standard "disconnect" — best-effort notify the
    // provider and clear our local state. Rabby (like most wallets) does
    // not revoke permissions via RPC; the user can lock/remove the site
    // in the wallet UI, but the app must no longer consider it connected.
    try {
      await eth?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
    } catch {
      /* non-standard / unsupported — ignore */
    }
    setAddress(null)
    setChainId(null)
  }, [])

  // ArrowRPC has no CORS headers, so reads must go through our proxy
  // (/api/rh/rpc) instead of the browser POSTing to the RPC directly.
  // Defer creation until after mount: viem's createPublicClient internally
  // uses Math.random() for the request id, and Next 16 cacheComponents flags
  // any non-stable value (Date.now / random) read during a client component's
  // render as an unstable prerender value.
  const [publicClient, setPublicClient] = useState<PublicClient | null>(null)
  useEffect(() => {
    setPublicClient(
      createPublicClient({
        chain: RH_CHAIN,
        transport: http('/api/rh/rpc'),
      }),
    )
  }, [])

  const getWalletClient = useCallback(async (): Promise<WalletClient> => {
    const eth = getEthereumProvider()
    if (!eth) throw new Error('No Rabby (or EVM wallet)')
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

  const getPublicClient = useCallback((): PublicClient => {
    if (publicClient) return publicClient
    return createPublicClient({
      chain: RH_CHAIN,
      transport: http('/api/rh/rpc'),
    })
  }, [publicClient])

  return {
    address,
    chainId,
    isCorrectChain: chainId === RH_CHAIN_ID,
    hasProvider,
    connecting,
    error,
    connect,
    disconnect,
    ensureChain,
    refresh,
    publicClient,
    getPublicClient,
    getWalletClient,
  }
}
