import { Connection, clusterApiUrl } from '@solana/web3.js'
import { getPrimaryRpcUrl, getPublicRpcUrl, resolveRpcUrls } from './rpc-urls'

const isServer = typeof window === 'undefined'

const getBestRpcUrl = (): string => {
  try {
    return isServer ? getPrimaryRpcUrl() : getPublicRpcUrl()
  } catch {
    return 'https://placeholder-rpc.solana.com'
  }
}

export const makeRpcRequest = async (body: unknown): Promise<unknown> => {
  if (isServer) {
    throw new Error('makeRpcRequest should only be used on client side. Use direct connection on server.')
  }

  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`RPC proxy request failed: ${response.statusText}`)
  }

  return response.json()
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
  return new Connection(endpoint, 'confirmed')
}

export const connection = createConnection('mainnet')

export { resolveRpcUrls, getPrimaryRpcUrl, getPublicRpcUrl }
