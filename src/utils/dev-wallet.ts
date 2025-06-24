/**
 * Developer wallet utilities for testing specific functionality
 */

// Cache for parsed dev wallets to avoid re-parsing on every call
let cachedDevWallets: string[] | null = null

/**
 * Get the list of developer wallet addresses from environment variables
 * Uses comma-separated list format: DEV_WALLETS=wallet1,wallet2,wallet3
 */
function getDevWallets(): string[] {
  if (cachedDevWallets !== null) {
    return cachedDevWallets
  }

  // Get comma-separated list from DEV_WALLETS environment variable
  const devWalletsEnv = process.env.DEV_WALLETS || process.env.NEXT_PUBLIC_DEV_WALLETS || ''
  
  const devWallets = devWalletsEnv
    .split(',')
    .map(wallet => wallet.trim())
    .filter(wallet => wallet.length > 0)

  // Remove duplicates and cache the result
  cachedDevWallets = Array.from(new Set(devWallets))
  
  if (cachedDevWallets.length > 0) {
    console.log(`🛠️ Found ${cachedDevWallets.length} developer wallet(s) configured`)
  }

  return cachedDevWallets
}

/**
 * Check if a wallet address belongs to a developer
 * @param walletAddress - The wallet address to check (can be string or PublicKey)
 * @returns true if the wallet is a developer wallet, false otherwise
 */
export function isDevWallet(walletAddress: string | { toString(): string } | null | undefined): boolean {
  if (!walletAddress) {
    return false
  }

  const addressString = typeof walletAddress === 'string' 
    ? walletAddress 
    : walletAddress.toString()

  const devWallets = getDevWallets()
  
  // Case-insensitive comparison for better reliability
  const normalizedAddress = addressString.toLowerCase().trim()
  const isMatch = devWallets.some(devWallet => 
    devWallet.toLowerCase().trim() === normalizedAddress
  )

  if (isMatch) {
    console.log(`🛠️ Developer wallet detected: ${addressString.substring(0, 8)}...`)
  }

  return isMatch
}

/**
 * Get all configured developer wallets (for debugging)
 * @returns Array of developer wallet addresses
 */
export function getConfiguredDevWallets(): string[] {
  return getDevWallets()
}

/**
 * Clear the cached dev wallets (useful for testing or if env vars change)
 */
export function clearDevWalletCache(): void {
  cachedDevWallets = null
}

/**
 * Hook-style function for React components to check dev wallet status
 * @param walletAddress - The wallet address to check
 * @returns boolean indicating if it's a dev wallet
 */
export function useIsDevWallet(walletAddress: string | { toString(): string } | null | undefined): boolean {
  return isDevWallet(walletAddress)
}

// Example usage:
/*
// In your .env.local file:
DEV_WALLETS=ABC123def456ghi789...,XYZ987uvw654rst321...,MNO456pqr789stu012...

// In your component:
import { isDevWallet, useIsDevWallet } from '@/utils/dev-wallet'

// Direct usage
if (isDevWallet(publicKey)) {
  console.log('This is a developer wallet!')
  // Show debug features, admin panel, etc.
}

// In React component
const isDev = useIsDevWallet(publicKey)
if (isDev) {
  // Show dev-only features
}
*/ 