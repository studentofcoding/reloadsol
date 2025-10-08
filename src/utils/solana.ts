import { Connection, clusterApiUrl } from '@solana/web3.js'
import { createConnection, connection as defaultConnection } from './connection'

// Re-export the connection utilities
export { createConnection, RPC_ENDPOINTS } from './connection'

// Default connection (re-exported)
export const connection = defaultConnection

// Jupiter API endpoints
export const JUPITER_API = {
  quote: 'https://lite-api.jup.ag/swap/v1/quote',
  swap: 'https://lite-api.jup.ag/swap/v1/swap',
  tokens: 'https://token.jup.ag/strict',
}

// Common token addresses
export const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
}

// Slippage options (in basis points)
export const SLIPPAGE_OPTIONS = [
  { label: '0.1%', value: 10 },
  { label: '0.5%', value: 50 },
  { label: '1%', value: 100 },
  { label: '2%', value: 200 },
  { label: '5%', value: 500 },
]

// Priority fee options (in lamports)
export const PRIORITY_FEE_OPTIONS = [
  { label: 'None', value: 0 },
  { label: 'Low (0.00005 SOL)', value: 5000 },
  { label: 'Medium (0.0003 SOL)', value: 30000 },
  { label: 'High (0.0015 SOL)', value: 150000 },
]

// Utility function to get SOL price with caching and fallback
export async function getSolPriceUSD(): Promise<number> {
  try {
    // Check if we're on the client side
    const isClientSide = typeof window !== 'undefined'

    if (isClientSide) {
      // Client-side: use the API endpoint
      const response = await fetch('/api/solprice', {
        headers: {
          'Cache-Control': 'max-age=30' // Use 30-second cache
        }
      });

      if (!response.ok) {
        throw new Error(`SOL price API error: ${response.status}`);
      }

      const data = await response.json();
      const price = data.price;

      if (typeof price === 'number' && price > 0) {
        console.log(`SOL price fetched: $${price} (source: ${data.source})`);
        return price;
      }

      throw new Error('Invalid SOL price data received');
    } else {
      // Server-side: use the core price fetching logic directly
      const { getSolPriceUSDCore } = await import('./sol-price-core');
      const result = await getSolPriceUSDCore();

      console.log(`SOL price fetched: $${result.price} (source: ${result.source})`);
      return result.price;
    }
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    // Return a reasonable fallback price if the API fails
    return 145; // Default SOL price
  }
}