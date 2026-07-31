// Constants extracted from src/app/api/trending/track/route.ts (REL-19). No logic changes.

// Lightweight toggle for verbose logging
export const DEBUG_LOG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
// Optional debug logger – only prints when DEBUG env is truthy
export const dbg = (...args: any[]): void => {
  if (DEBUG_LOG) {
    console.log(...args)
  }
}

export const DISCORD_MAX_LENGTH = 2000
export const DISCORD_SAFE_LENGTH = 1900 // Leave some buffer

// === Table selection (use alternate tables in local development to avoid prod collisions) ===
export const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

// === Discord Trade Alert Configuration ===
export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_AUTO_TRADE || ''

// Safety mechanisms and connection management
export const MAX_SOL_AT_RISK = parseFloat(process.env.MAX_SOL_AT_RISK || '1.0') // Maximum SOL that can be at risk
export const MIN_SOL_BALANCE = parseFloat(process.env.MIN_SOL_BALANCE || '0.1') // Minimum SOL balance to maintain

// Configure duplicate prevention
export const TOKEN_PURCHASE_COOLDOWN_HOURS = parseInt(process.env.TOKEN_PURCHASE_COOLDOWN_HOURS || '24') // Hours to wait before re-purchasing same token
export const MAX_PURCHASES_PER_TOKEN = parseInt(process.env.MAX_PURCHASES_PER_TOKEN || '2') // Maximum times to purchase same token
export const MIN_WALLET_BALANCE_FOR_DUPLICATE_CHECK = 1000 // Minimum token balance to consider "already holding"
