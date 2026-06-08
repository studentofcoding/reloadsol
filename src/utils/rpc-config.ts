// RPC Configuration utility for multiple endpoints
import { buildShyftRpcUrl, resolveRpcUrls } from './rpc-urls'

const isServer = typeof window === 'undefined'

/** Parse RPC URLs — delegates to shared resolver when no override given. */
export const parseRpcUrls = (envValue?: string): string[] => {
  if (envValue) {
    return envValue
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url.length > 0)
  }
  return resolveRpcUrls()
}

/**
 * Client-side RPC proxy function
 * All client-side RPC requests should use this instead of direct connections
 */
export const makeClientRpcRequest = async (body: any): Promise<any> => {
  if (isServer) {
    throw new Error('makeClientRpcRequest should only be used on client side. Use direct connection on server.')
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

/**
 * Get RPC health status (client-side)
 */
export const getRpcHealth = async (): Promise<any> => {
  if (isServer) {
    throw new Error('getRpcHealth should only be used on client side.')
  }

  const response = await fetch('/api/rpc/health')
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.statusText}`)
  }

  return response.json()
}

/**
 * Example RPC configurations for different providers
 */
export const RPC_EXAMPLES = {
  shyft: [buildShyftRpcUrl('YOUR_SHYFT_API_KEY')],
  public: ['https://solana-api.projectserum.com'],
  premium: [
    buildShyftRpcUrl('YOUR_SHYFT_API_KEY'),
    'https://solana-mainnet.rpc.extrnode.com/YOUR_API_KEY',
  ],
  highPerformance: [
    buildShyftRpcUrl('YOUR_SHYFT_API_KEY'),
    'https://solana-mainnet.rpc.extrnode.com/YOUR_API_KEY',
    'https://solana-api.projectserum.com',
  ],
}

/**
 * Validate RPC URL format
 */
export const validateRpcUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Get configuration recommendations based on use case
 */
export const getConfigRecommendations = (useCase: 'development' | 'production' | 'high-throughput'): {
  description: string
  example: string
  endpoints: string[]
} => {
  switch (useCase) {
    case 'development':
      return {
        description: 'Shyft RPC for development and testing',
        example: 'SHYFT_API_KEY=your-key\nRPC_URL=https://rpc.shyft.to?api_key=your-key',
        endpoints: RPC_EXAMPLES.shyft,
      }

    // case 'pump-fun':
    //   return {
    //     description: 'Optimized for Pump.fun trading with Helius RPC',
    //     example: 'RPC_URL=https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b,https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
    //     endpoints: RPC_EXAMPLES.pumpFun
    //   }

    case 'production':
      return {
        description: 'Shyft primary with optional fallback endpoints',
        example: 'RPC_URL=https://rpc.shyft.to?api_key=YOUR_KEY,https://solana-api.projectserum.com',
        endpoints: RPC_EXAMPLES.premium,
      }

    case 'high-throughput':
      return {
        description: 'Shyft plus multiple fallback endpoints',
        example: 'RPC_URL=https://rpc.shyft.to?api_key=KEY1,https://solana-mainnet.rpc.extrnode.com/KEY2',
        endpoints: RPC_EXAMPLES.highPerformance,
      }

    default:
      return getConfigRecommendations('development')
  }
}

/**
 * Environment variable setup instructions
 */
export const SETUP_INSTRUCTIONS = `
# Shyft RPC Configuration (https://shyft.to)

## Basic Setup
SHYFT_API_KEY=your-shyft-api-key
RPC_URL=https://rpc.shyft.to?api_key=your-shyft-api-key
NEXT_PUBLIC_RPC_URL=https://rpc.shyft.to?api_key=your-shyft-api-key

## With Fallbacks (comma-separated)
RPC_URL=https://rpc.shyft.to?api_key=KEY1,https://solana-api.projectserum.com
` 