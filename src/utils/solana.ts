import { Connection, clusterApiUrl } from '@solana/web3.js'
import { createConnection, connection as defaultConnection } from './connection'

// Re-export the connection utilities
export { createConnection, RPC_ENDPOINTS } from './connection'

// Default connection (re-exported)
export const connection = defaultConnection

// Jupiter API endpoints
export const JUPITER_API = {
  quote: 'https://quote-api.jup.ag/v6/quote',
  swap: 'https://quote-api.jup.ag/v6/swap',
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
  { label: 'Low (0.00001 SOL)', value: 10000 },
  { label: 'Medium (0.0001 SOL)', value: 100000 },
  { label: 'High (0.001 SOL)', value: 1000000 },
] 