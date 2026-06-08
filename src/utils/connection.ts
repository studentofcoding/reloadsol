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

export const RPC_ENDPOINTS = {
  mainnet: getBestRpcUrl(),
  devnet: clusterApiUrl('devnet'),
  testnet: clusterApiUrl('testnet'),
}

export const createConnection = (network: 'mainnet' | 'devnet' | 'testnet' = 'mainnet') => {
  return new Connection(RPC_ENDPOINTS[network], 'confirmed')
}

export const connection = createConnection('mainnet')

export { resolveRpcUrls, getPrimaryRpcUrl, getPublicRpcUrl }
