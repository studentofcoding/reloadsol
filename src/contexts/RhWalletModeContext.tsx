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
  parseRhWalletMode,
  readStoredRhWalletMode,
  writeStoredRhWalletMode,
  type RhWalletMode,
} from '@/utils/rh-wallet-mode'

type RhWalletModeContextValue = {
  mode: RhWalletMode
  setMode: (m: RhWalletMode) => void
}

const RhWalletModeContext = createContext<RhWalletModeContextValue | null>(null)

export function RhWalletModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<RhWalletMode>('parent')

  useEffect(() => {
    const stored = readStoredRhWalletMode()
    setModeState(stored)
    writeStoredRhWalletMode(stored)
  }, [])

  const setMode = useCallback((m: RhWalletMode) => {
    const next = parseRhWalletMode(m)
    setModeState(next)
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
