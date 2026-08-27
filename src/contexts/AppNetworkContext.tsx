'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  coerceAppNetwork,
  readStoredAppNetwork,
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

export function AppNetworkProvider({
  children,
  isDevUser,
  canUseRh,
}: {
  children: ReactNode
  isDevUser: boolean
  canUseRh: boolean
}) {
  // Do not coerce on first paint — disconnected wallets report canUseRh=false and
  // would wipe a stored robinhood preference before reconnect.
  const [network, setNetworkState] = useState<AppNetwork>(() =>
    readStoredAppNetwork(),
  )
  const [rhGate, setRhGate] = useState(canUseRh)

  if (rhGate !== canUseRh) {
    const { network: next, shouldWrite } = resolveNetworkOnRhGateChange({
      prevCanUseRh: rhGate,
      canUseRh,
      current: network,
      stored: readStoredAppNetwork(),
    })
    setRhGate(canUseRh)
    if (next !== network) setNetworkState(next)
    if (shouldWrite) writeStoredAppNetwork(next)
  }

  const setNetwork = useCallback(
    (n: AppNetwork, opts?: { skipCoerce?: boolean }) => {
      const next =
        opts?.skipCoerce && n === 'robinhood'
          ? 'robinhood'
          : coerceAppNetwork(n, canUseRh)
      setNetworkState(next)
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
      // The active network IS the effective chain — the per-chain pages
      // (NetworkPreface) ensure this matches the URL on mount, and the
      // setNetwork() callback still coerces manual selections. We no longer
      // force RH to 'sol' when canUseRh is false; that would clobber
      // /buy/robinhood for a user who hasn't connected a wallet yet.
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
