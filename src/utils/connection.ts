import { Connection, clusterApiUrl } from '@solana/web3.js'

// Parse RPC URLs from environment variable
const getRpcUrls = (): string[] => {
  const rpcUrl = typeof window === 'undefined' ? process.env.RPC_URL : process.env.NEXT_PUBLIC_RPC_URL
  if (!rpcUrl) {
    return ['https://api.mainnet-beta.solana.com']
  }
  
  return rpcUrl
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0)
}

// Get the best available RPC URL (first healthy one)
const getBestRpcUrl = (): string => {
  const urls = getRpcUrls()
  return urls[0] || 'https://api.mainnet-beta.solana.com'
}

// Override global fetch for RPC requests to use our proxy
const originalFetch = typeof window !== 'undefined' ? window.fetch : null

if (typeof window !== 'undefined' && originalFetch) {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // Check if this is an RPC request to our configured endpoints
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const rpcUrls = getRpcUrls()
    
    // If it's a POST request to one of our RPC URLs, proxy it
    if (init?.method === 'POST' && rpcUrls.some(rpcUrl => url.includes(rpcUrl.split('?')[0]))) {
      try {
        const response = await originalFetch('/api/rpc', {
          ...init,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...init.headers,
          },
        })
        return response
      } catch (error) {
        console.warn('Proxy request failed, falling back to direct:', error)
        // Fallback to original fetch
        return originalFetch(input, init)
      }
    }
    
    // For all other requests (including WebSocket upgrades), use original fetch
    return originalFetch(input, init)
  }
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