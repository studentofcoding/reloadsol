import { Connection, clusterApiUrl } from '@solana/web3.js'

// Environment detection
const isServer = typeof window === 'undefined'

// Server-side RPC configuration (private env vars only)
const getServerRpcUrls = (): string[] => {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) {
    return ['https://rpc.shyft.to?api_key=dt_BAV8lwogCz_vn']
  }
  
  return rpcUrl
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0)
}

// Client-side RPC configuration (placeholder - forces API proxy usage)
const getClientRpcUrls = (): string[] => {
  // Client should use API proxy for all RPC requests
  // Placeholder URL for WebSocket connections (they'll mostly fail gracefully)
  return ['https://rpc.shyft.to?api_key=dt_BAV8lwogCz_vn']
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