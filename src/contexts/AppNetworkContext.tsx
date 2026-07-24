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
  setNetwork: (n: AppNetwork) => void
  isDevUser: boolean
}

const AppNetworkContext = createContext<AppNetworkContextValue | null>(null)

export function AppNetworkProvider({
  children,
  isDevUser,
}: {
  children: ReactNode
  isDevUser: boolean
}) {
  const [network, setNetworkState] = useState<AppNetwork>(() =>
    coerceAppNetwork(readStoredAppNetwork(), isDevUser),
  )
  const [devGate, setDevGate] = useState(isDevUser)

  if (devGate !== isDevUser) {
    setDevGate(isDevUser)
    const next = coerceAppNetwork(network, isDevUser)
    if (next !== network) {
      setNetworkState(next)
      writeStoredAppNetwork(next)
    } else {
      writeStoredAppNetwork(network)
    }
  }

  const setNetwork = useCallback(
    (n: AppNetwork) => {
      const next = coerceAppNetwork(n, isDevUser)
      setNetworkState(next)
      writeStoredAppNetwork(next)
    },
    [isDevUser],
  )

  const value = useMemo(
    () => ({ network, setNetwork, isDevUser }),
    [network, setNetwork, isDevUser],
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
