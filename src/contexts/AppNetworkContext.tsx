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

type AppNetworkContextValue = {
  network: AppNetwork
  setNetwork: (n: AppNetwork, opts?: { skipCoerce?: boolean }) => void
  isDevUser: boolean
  canUseRh: boolean
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
  const [network, setNetworkState] = useState<AppNetwork>(() =>
    coerceAppNetwork(readStoredAppNetwork(), canUseRh),
  )
  const [rhGate, setRhGate] = useState(canUseRh)

  if (rhGate !== canUseRh) {
    setRhGate(canUseRh)
    const next = coerceAppNetwork(network, canUseRh)
    if (next !== network) {
      setNetworkState(next)
      writeStoredAppNetwork(next)
    } else {
      writeStoredAppNetwork(network)
    }
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
    () => ({ network, setNetwork, isDevUser, canUseRh }),
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
