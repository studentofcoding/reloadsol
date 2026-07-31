// Shared in-memory trading state extracted from src/app/api/trending/track/route.ts (REL-19).
// The mutable connection/keypair bindings live here so both the initializers
// below and readers in other modules observe the same values (ES live bindings).
import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js'
import { createRpcConnection } from '@/utils/rpc-urls'
import { loadTradingKeypair, createSignerFromKeypair } from './executors'

// Wallet balance monitoring for manual sell detection
export const monitoredTokens = new Map<string, {
  lastBalance: number
  lastCheck: number
  tokenData: any
}>()

export const activeTrades = new Set<string>()

// Add strategy-specific active trades tracking
export const activeTradesByStrategy = new Map<string, Set<string>>()

// Initialize strategy tracking
export function initializeStrategyTracking(strategies: string[]) {
  strategies.forEach(strategyId => {
    if (!activeTradesByStrategy.has(strategyId)) {
      activeTradesByStrategy.set(strategyId, new Set<string>())
    }
  })
}

// Enhanced duplicate prevention: track recent purchases
export const recentPurchases = new Map<string, { count: number, lastPurchase: Date, purchaseDates: Date[] }>()

// Connection management for real trading
export let tradingConnection: Connection | null = null
export let tradingKeypair: Keypair | null = null
export let tradingSigner: ((transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>) | null = null

// Connection management for real trading
export function initializeTradingConnection(): Connection {
  if (!tradingConnection) {
    tradingConnection = createRpcConnection('confirmed')
    console.log('🌐 Real trading connection initialized with Shyft RPC')
  }
  return tradingConnection
}


export async function initializeTradingKeypair(keypairPath?: string): Promise<void> {
  if (!tradingKeypair || !tradingSigner) {
    tradingKeypair = loadTradingKeypair(keypairPath)
    tradingSigner = createSignerFromKeypair(tradingKeypair)
    console.log(`🔑 Trading keypair loaded: ${tradingKeypair.publicKey.toBase58()}`)
  }
}
