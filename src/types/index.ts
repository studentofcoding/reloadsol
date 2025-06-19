import { PublicKey } from '@solana/web3.js'

export type FeeOperationType = 'BUY' | 'SELL' | 'CLOSE'

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
  feeInfo: {
    totalFees: number // Total fees paid in SOL
    devFee: number // Fee paid to dev wallet
    referralFee: number // Fee paid to referral (if any)
    feePerOperation: number // Fee rate per operation
    totalOperations: number // Number of successful operations
    operationType: FeeOperationType // Type of operation for fee calculation
  }
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