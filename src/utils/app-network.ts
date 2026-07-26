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
}
