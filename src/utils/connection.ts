import { Connection, clusterApiUrl } from '@solana/web3.js'

// Environment detection
const isServer = typeof window === 'undefined'

// Server-side RPC configuration (private env vars only)
const getServerRpcUrls = (): string[] => {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) {
    return ['https://mainnet.helius-rpc.com/?api-key=9b707ec2-17da-4c3a-b17d-19bb3a58dd2d']
  }

  return rpcUrl
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0)
}

// Client-side RPC configuration
const getClientRpcUrls = (): string[] => {
  // Try to get from env var first
  const envRpcUrl = process.env.NEXT_PUBLIC_RPC_URL
  if (envRpcUrl) {
    return envRpcUrl
      .split(',')
      .map(url => url.trim())
      .filter(url => url.length > 0)
  }

  // Fallback to hardcoded URL if env var is missing
  return ['https://mainnet.helius-rpc.com/?api-key=9b707ec2-17da-4c3a-b17d-19bb3a58dd2d']
}

// Get RPC URLs based on environment
const getRpcUrls = (): string[] => {
  return isServer ? getServerRpcUrls() : getClientRpcUrls()
}

// Get the best available RPC URL (first healthy one)
const getBestRpcUrl = (): string => {
  const urls = getRpcUrls()
  return urls[0] || 'https://placeholder-rpc.solana.com'
}

// Client-side RPC proxy function
export const makeRpcRequest = async (body: any): Promise<any> => {
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

// RPC endpoints - use direct URLs so WebSocket connections work
export const RPC_ENDPOINTS = {
  mainnet: getBestRpcUrl(),
  devnet: clusterApiUrl('devnet'),
  testnet: clusterApiUrl('testnet'),
}

// Create connection with direct URL (WebSocket will work, HTTP will be proxied via fetch override)
export const createConnection = (network: 'mainnet' | 'devnet' | 'testnet' = 'mainnet') => {
  return new Connection(RPC_ENDPOINTS[network], 'confirmed')
}

// Default connection
export const connection = createConnection('mainnet') 