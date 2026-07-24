export type AppNetwork = 'sol' | 'robinhood'

export const APP_NETWORK_STORAGE_KEY = 'reloadsol.appNetwork'

export function parseAppNetwork(raw: string | null | undefined): AppNetwork {
  return raw === 'robinhood' ? 'robinhood' : 'sol'
}

/** Non-dev users cannot stay on Robinhood. */
export function coerceAppNetwork(
  network: AppNetwork,
  isDevUser: boolean,
): AppNetwork {
  if (!isDevUser && network === 'robinhood') return 'sol'
  return network
}

export function readStoredAppNetwork(): AppNetwork {
  if (typeof window === 'undefined') return 'sol'
  try {
    return parseAppNetwork(sessionStorage.getItem(APP_NETWORK_STORAGE_KEY))
  } catch {
    return 'sol'
  }
}

export function writeStoredAppNetwork(network: AppNetwork): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(APP_NETWORK_STORAGE_KEY, network)
  } catch {
    /* ignore */
  }
}
