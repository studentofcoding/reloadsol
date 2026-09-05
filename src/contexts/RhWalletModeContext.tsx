'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  parseRhWalletMode,
  readStoredRhWalletMode,
  subscribeRhWalletMode,
  writeStoredRhWalletMode,
  type RhWalletMode,
} from '@/utils/rh-wallet-mode'

type RhWalletModeContextValue = {
  mode: RhWalletMode
  setMode: (m: RhWalletMode) => void
}

const RhWalletModeContext = createContext<RhWalletModeContextValue | null>(null)

function getServerRhWalletModeSnapshot(): RhWalletMode {
  return 'parent'
}

export function RhWalletModeProvider({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(
    subscribeRhWalletMode,
    readStoredRhWalletMode,
    getServerRhWalletModeSnapshot,
  )

  const setMode = useCallback((m: RhWalletMode) => {
    const next = parseRhWalletMode(m)
    writeStoredRhWalletMode(next)
  }, [])

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode])

  return (
    <RhWalletModeContext.Provider value={value}>
      {children}
    </RhWalletModeContext.Provider>
  )
}

export function useRhWalletMode(): RhWalletModeContextValue {
  const ctx = useContext(RhWalletModeContext)
  if (!ctx) {
    throw new Error('useRhWalletMode must be used within RhWalletModeProvider')
  }
  return ctx
}
