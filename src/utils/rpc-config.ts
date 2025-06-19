// RPC Configuration utility for multiple endpoints

/**
 * Parse RPC URLs from environment variable
 * Supports comma-separated list of URLs
 */
export const parseRpcUrls = (envValue?: string): string[] => {
  if (!envValue) {
    return ['https://api.mainnet-beta.solana.com']
  }
  
  return envValue
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0)
}

/**
 * Example RPC configurations for different providers
 */
export const RPC_EXAMPLES = {
  // Free public endpoints
  public: [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
  ],
  
  // Premium providers (replace with your API keys)
  premium: [
    'https://rpc.shyft.to/?api_key=YOUR_SHYFT_API_KEY',
    'https://solana-mainnet.rpc.extrnode.com/YOUR_API_KEY',
    'https://api.mainnet-beta.solana.com', // fallback
  ],
  
  // High-performance setup
  highPerformance: [
    'https://rpc.shyft.to/?api_key=YOUR_SHYFT_API_KEY',
    'https://solana-mainnet.rpc.extrnode.com/YOUR_API_KEY',
    'https://api.mainnet-beta.solana.com',
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
        example: 'NEXT_PUBLIC_RPC_URL=https://api.mainnet-beta.solana.com',
        endpoints: RPC_EXAMPLES.public
      }
      
    case 'production':
      return {
        description: 'Reliable setup with premium endpoints and fallbacks',
        example: 'NEXT_PUBLIC_RPC_URL=https://rpc.shyft.to/?api_key=YOUR_KEY,https://api.mainnet-beta.solana.com',
        endpoints: RPC_EXAMPLES.premium
      }
      
    case 'high-throughput':
      return {
        description: 'Maximum reliability with multiple premium endpoints',
        example: 'NEXT_PUBLIC_RPC_URL=https://rpc.shyft.to/?api_key=KEY1,https://solana-mainnet.rpc.extrnode.com/KEY2,https://api.mainnet-beta.solana.com',
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
NEXT_PUBLIC_RPC_URL=https://api.mainnet-beta.solana.com

## With Premium Provider (Recommended for Production)
NEXT_PUBLIC_RPC_URL=https://rpc.shyft.to/?api_key=YOUR_SHYFT_KEY,https://api.mainnet-beta.solana.com

## High Availability Setup (Multiple Providers)
NEXT_PUBLIC_RPC_URL=https://rpc.shyft.to/?api_key=KEY1,https://solana-mainnet.rpc.extrnode.com/KEY2,https://api.mainnet-beta.solana.com,https://solana-api.projectserum.com

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