'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  coerceAppNetwork,
  readStoredAppNetwork,
  subscribeAppNetwork,
  writeStoredAppNetwork,
  type AppNetwork,
} from '@/utils/app-network'
import { resolveNetworkOnRhGateChange } from '@/utils/app-network-gate'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'

type AppNetworkContextValue = {
  network: AppNetwork
  setNetwork: (n: AppNetwork, opts?: { skipCoerce?: boolean }) => void
  isDevUser: boolean
  canUseRh: boolean
  /** Canonical chain for trade APIs: 'sol' if gated, else the active network. */
  effectiveChain: GmgnTradeChain
}

const AppNetworkContext = createContext<AppNetworkContextValue | null>(null)

function getServerNetworkSnapshot(): AppNetwork {
  return 'sol'
}

export function AppNetworkProvider({
  children,
  isDevUser,
  canUseRh,
}: {
  children: ReactNode
  isDevUser: boolean
  canUseRh: boolean
}) {
  const network = useSyncExternalStore(
    subscribeAppNetwork,
    readStoredAppNetwork,
    getServerNetworkSnapshot,
  )
  const prevCanUseRh = useRef(canUseRh)

  useEffect(() => {
    if (prevCanUseRh.current === canUseRh) return
    const { network: next, shouldWrite } = resolveNetworkOnRhGateChange({
      prevCanUseRh: prevCanUseRh.current,
      canUseRh,
      current: network,
      stored: readStoredAppNetwork(),
    })
    prevCanUseRh.current = canUseRh
    if (next !== network || shouldWrite) {
      writeStoredAppNetwork(next)
    }
  }, [canUseRh, network])

  const setNetwork = useCallback(
    (n: AppNetwork, opts?: { skipCoerce?: boolean }) => {
      const next =
        opts?.skipCoerce && n === 'robinhood'
          ? 'robinhood'
          : coerceAppNetwork(n, canUseRh)
      writeStoredAppNetwork(next)
    },
    [canUseRh],
  )

  const value = useMemo(
    () => ({
      network,
      setNetwork,
      isDevUser,
      canUseRh,
      effectiveChain: network as GmgnTradeChain,
    }),
    [network, setNetwork, isDevUser, canUseRh],
  )

  return (
    <AppNetworkContext.Provider value={value}>
      {children}
    </AppNetworkContext.Provider>
  )
}

export function useAppNetwork(): AppNetworkContextValue {
  const ctx = useContext(AppNetworkContext)
  if (!ctx) {
    throw new Error('useAppNetwork must be used within AppNetworkProvider')
  }
  return ctx
}
