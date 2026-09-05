export type AppNetwork = 'sol' | 'robinhood'

export const APP_NETWORK_STORAGE_KEY = 'reloadsol.appNetwork'

export function parseAppNetwork(raw: string | null | undefined): AppNetwork {
  return raw === 'robinhood' ? 'robinhood' : 'sol'
}

/** Users without RH access cannot stay on Robinhood. */
export function coerceAppNetwork(
  network: AppNetwork,
  canUseRh: boolean,
): AppNetwork {
  if (!canUseRh && network === 'robinhood') return 'sol'
  return network
}

const networkListeners = new Set<() => void>()

function emitAppNetworkChange(): void {
  for (const cb of networkListeners) cb()
}

/** Subscribe for useSyncExternalStore (same-tab writes + other-tab storage). */
export function subscribeAppNetwork(onStoreChange: () => void): () => void {
  networkListeners.add(onStoreChange)
  if (typeof window === 'undefined') {
    return () => {
      networkListeners.delete(onStoreChange)
    }
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === APP_NETWORK_STORAGE_KEY || e.key == null) onStoreChange()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    networkListeners.delete(onStoreChange)
    window.removeEventListener('storage', onStorage)
  }
}

function readLocal(): string | null {
  try {
    return localStorage.getItem(APP_NETWORK_STORAGE_KEY)
  } catch {
    return null
  }
}

function readSession(): string | null {
  try {
    return sessionStorage.getItem(APP_NETWORK_STORAGE_KEY)
  } catch {
    return null
  }
}

/** Prefer localStorage; one-time migrate from sessionStorage if present. */
export function readStoredAppNetwork(): AppNetwork {
  if (typeof window === 'undefined') return 'sol'
  try {
    const local = readLocal()
    if (local != null) return parseAppNetwork(local)
    const session = readSession()
    if (session != null) {
      const network = parseAppNetwork(session)
      writeStoredAppNetwork(network)
      try {
        sessionStorage.removeItem(APP_NETWORK_STORAGE_KEY)
      } catch {
        /* ignore */
      }
      return network
    }
    return 'sol'
  } catch {
    return 'sol'
  }
}

export function writeStoredAppNetwork(network: AppNetwork): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(APP_NETWORK_STORAGE_KEY, network)
  } catch {
    /* ignore */
  }
  emitAppNetworkChange()
}
