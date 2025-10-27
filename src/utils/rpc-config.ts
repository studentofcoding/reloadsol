// RPC Configuration utility for multiple endpoints

// Environment detection
const isServer = typeof window === 'undefined'

/**
 * Parse RPC URLs from environment variable
 * Supports comma-separated list of URLs
 */
export const parseRpcUrls = (envValue?: string): string[] => {
  if (!envValue) {
    return ['https://mainnet.helius-rpc.com/?api-key=9b707ec2-17da-4c3a-b17d-19bb3a58dd2d']
  }

  return envValue
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0)
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
  // Free public endpoints
  public: [
    'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
    'https://solana-api.projectserum.com',
  ],

  // Pump.fun specialized endpoint
  pumpFun: [
    'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
    'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b', // fallback
  ],

  // Premium providers (replace with your API keys)
  premium: [
    'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
    'https://rpc.shyft.to/?api_key=YOUR_SHYFT_API_KEY',
    'https://solana-mainnet.rpc.extrnode.com/YOUR_API_KEY',
    'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b', // fallback
  ],

  // High-performance setup
  highPerformance: [
    'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
    'https://rpc.shyft.to/?api_key=YOUR_SHYFT_API_KEY',
    'https://solana-mainnet.rpc.extrnode.com/YOUR_API_KEY',
    'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
    'https://solana-api.projectserum.com',
  ]
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
        description: 'Basic setup for development and testing',
        example: 'RPC_URL=https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
        endpoints: RPC_EXAMPLES.public
      }

    // case 'pump-fun':
    //   return {
    //     description: 'Optimized for Pump.fun trading with Helius RPC',
    //     example: 'RPC_URL=https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b,https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
    //     endpoints: RPC_EXAMPLES.pumpFun
    //   }

    case 'production':
      return {
        description: 'Reliable setup with premium endpoints and fallbacks',
        example: 'RPC_URL=https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b,https://rpc.shyft.to/?api_key=YOUR_KEY,https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
        endpoints: RPC_EXAMPLES.premium
      }

    case 'high-throughput':
      return {
        description: 'Maximum reliability with multiple premium endpoints',
        example: 'RPC_URL=https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b,https://rpc.shyft.to/?api_key=KEY1,https://solana-mainnet.rpc.extrnode.com/KEY2,https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
        endpoints: RPC_EXAMPLES.highPerformance
      }

    default:
      return getConfigRecommendations('development')
  }
}

/**
 * Environment variable setup instructions
 */
export const SETUP_INSTRUCTIONS = `
# Multiple RPC Endpoints Configuration

## Basic Setup (Development)
RPC_URL=https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b

## With Premium Provider (Recommended for Production)
RPC_URL=https://rpc.shyft.to/?api_key=YOUR_SHYFT_KEY,https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b

## High Availability Setup (Multiple Providers)
RPC_URL=https://rpc.shyft.to/?api_key=KEY1,https://solana-mainnet.rpc.extrnode.com/KEY2,https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b,https://solana-api.projectserum.com

## How It Works:
1. The system tests all endpoints automatically
2. Uses the fastest healthy endpoint
3. Automatically fails over if an endpoint goes down
4. Caches health status for 1 minute
5. Removes failed endpoints from the rotation

## Recommended Providers:
- Shyft.to (Premium, reliable)
- Extrnode (High performance)
- Solana Labs (Free, public)
- Project Serum (Free, public)
` 