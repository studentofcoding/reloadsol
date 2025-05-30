import { PublicKey } from '@solana/web3.js'

export interface TokenPurchase {
  mintAddress: string
  amount: number
  symbol?: string
  name?: string
}

export interface BulkBuyRequest {
  solAmount: number
  tokenMints: string[]
  slippage: number
  priorityFee: number
}

export interface BulkBuyResult {
  success: boolean
  successfulPurchases: TokenPurchase[]
  failedPurchases: { mintAddress: string; error: string }[]
  totalSpent: number
  signatures: string[]
}

export interface SwapQuote {
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: string
  slippageBps: number
  platformFee?: {
    amount: string
    feeBps: number
  }
  priceImpactPct: string
  routePlan: any[]
}

export interface SwapTransaction {
  swapTransaction: string
  lastValidBlockHeight: number
}

export interface TokenInfo {
  address: string
  chainId: number
  decimals: number
  name: string
  symbol: string
  logoURI?: string
  tags?: string[]
}

export interface WalletContextState {
  publicKey: PublicKey | null
  connected: boolean
  connecting: boolean
  disconnecting: boolean
  wallet: any
  signTransaction?: (transaction: any) => Promise<any>
  signAllTransactions?: (transactions: any[]) => Promise<any[]>
  sendTransaction?: (transaction: any, connection: any, options?: any) => Promise<string>
} 