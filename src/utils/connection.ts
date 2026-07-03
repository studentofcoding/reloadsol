import { Connection, clusterApiUrl } from '@solana/web3.js'
import { getPrimaryRpcUrl, getPublicRpcUrl, resolveRpcUrls } from './rpc-urls'
import { getTradeProvider } from './trade-provider'

const isServer = typeof window === 'undefined'

const getBestRpcUrl = (): string => {
  try {
    return isServer ? getPrimaryRpcUrl() : getPublicRpcUrl()
  } catch {
    return 'https://placeholder-rpc.solana.com'
  }
}

export function getTradeProviderHeaders(): Record<string, string> {
  if (getTradeProvider() === 'shyft') {
    return { 'X-Trade-Provider': 'shyft' }
  }
  return {}
}

/** Connection that tags /api/rpc requests with the active trade provider. */
export function createTradeAwareConnection(endpoint: string): Connection {
  const providerHeaders = getTradeProviderHeaders()
  if (Object.keys(providerHeaders).length === 0) {
    return new Connection(endpoint, 'confirmed')
  }
  return new Connection(endpoint, {
    commitment: 'confirmed',
    httpHeaders: providerHeaders,
  })
}

export const makeRpcRequest = async (body: unknown): Promise<unknown> => {
  if (isServer) {
    throw new Error('makeRpcRequest should only be used on client side. Use direct connection on server.')
  }

  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getTradeProviderHeaders(),
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`RPC proxy request failed: ${response.statusText}`)
  }

  return response.json()
}

/** Fetch RPC diagnostics with trade provider header. */
export async function fetchRpcDiagnostics(
  init?: RequestInit,
): Promise<Response> {
  return fetch('/api/rpc/diagnostics', {
    ...init,
    headers: {
      ...init?.headers,
      ...getTradeProviderHeaders(),
    },
  })
}

/** Same-origin RPC proxy for browser clients (avoids CSP and hides API keys). */
export function getBrowserConnectionEndpoint(): string {
  if (typeof window === 'undefined') {
    return getPrimaryRpcUrl()
  }
  return `${window.location.origin}/api/rpc`
}

export const RPC_ENDPOINTS = {
  mainnet: getBestRpcUrl(),
  devnet: clusterApiUrl('devnet'),
  testnet: clusterApiUrl('testnet'),
}

export const createConnection = (network: 'mainnet' | 'devnet' | 'testnet' = 'mainnet') => {
  const endpoint =
    network === 'mainnet' && !isServer
      ? getBrowserConnectionEndpoint()
      : RPC_ENDPOINTS[network]
  return createTradeAwareConnection(endpoint)
}

let cachedConnection: Connection | null = null

/** Lazily created — avoids instantiating Connection during SSR module load (Turbopack). */
export function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = createConnection('mainnet')
  }
  return cachedConnection
}

export { resolveRpcUrls, getPrimaryRpcUrl, getPublicRpcUrl }
