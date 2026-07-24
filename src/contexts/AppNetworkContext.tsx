'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  const [network, setNetworkState] = useState<AppNetwork>('sol')

  useEffect(() => {
    const stored = coerceAppNetwork(readStoredAppNetwork(), isDevUser)
    setNetworkState(stored)
    writeStoredAppNetwork(stored)
  }, [isDevUser])

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
