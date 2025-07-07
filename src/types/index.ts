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

// New types for trade comparison API
export type TradeProvider = 'jupiter' | 'dflow' | 'solana-tracker' | 'gmgn' | 'pump-fun'

export interface TradeQuoteRequest {
  inputMint: string
  outputMint: string
  amount: string // Amount in smallest unit (lamports for SOL)
  slippageBps: number
  userPublicKey: string
}

export interface ProviderQuote {
  provider: TradeProvider
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  slippageBps: number
  priceImpactPct: string
  responseTime: number // milliseconds
  success: boolean
  error?: string
  route?: any[] // Provider-specific route information
  fees?: {
    totalFeeLamports: number
    feePercentage: number
  }
  // Provider-specific data
  providerData?: {
    jupiter?: {
      routePlan: any[]
      contextSlot?: number
      timeTaken?: number
    }
    dflow?: {
      intentId?: string
      guaranteedAmount?: string
      estimatedTime?: number
    }
    solanaTracker?: {
      marketData?: any
      liquidityScore?: number
      txn?: string
      type?: string
      timeTaken?: number
      executionPrice?: number
      currentPrice?: number
    }
    gmgn?: {
      routeData?: any
      estimatedGas?: number
      estimatedTime?: number
      poolInfo?: any
      timeTaken?: number
    }
    'pump-fun'?: {
      routePlan?: any[]
      marketPrice?: number
      liquidityUsd?: number
      timeTaken?: number
      rpcEndpoint?: string
    }
  }
}

export interface TradeComparison {
  request: TradeQuoteRequest
  quotes: ProviderQuote[]
  bestQuote: ProviderQuote | null
  comparison: {
    bestPrice: {
      provider: TradeProvider
      outAmount: string
      advantage: string // percentage advantage over others
    }
    fastestResponse: {
      provider: TradeProvider
      responseTime: number
    }
    lowestSlippage: {
      provider: TradeProvider
      priceImpactPct: string
    }
    mostReliable: {
      provider: TradeProvider
      successRate: number // based on historical data
    }
  }
  summary: {
    totalProvidersQueried: number
    successfulQuotes: number
    failedQuotes: number
    averageResponseTime: number
    recommendation: TradeProvider
    recommendationReason: string
  }
  timestamp: number
}

export interface ProviderConfig {
  jupiter: {
    apiUrl: string
    maxRetries: number
    timeout: number
  }
  dflow: {
    apiUrl: string
    maxRetries: number
    timeout: number
  }
  solanaTracker: {
    apiUrl: string
    maxRetries: number
    timeout: number
  }
  gmgn: {
    apiUrl: string
    maxRetries: number
    timeout: number
  }
  'pump-fun': {
    apiUrl: string
    rpcUrl: string
    maxRetries: number
    timeout: number
  }
}

export interface TradeExecutionRequest {
  provider: TradeProvider
  quote: ProviderQuote
  userPublicKey: string
  priorityFeeLamports?: number
}

export interface TradeExecutionResult {
  success: boolean
  signature?: string
  error?: string
  provider: TradeProvider
  actualAmountReceived?: string
  actualSlippage?: string
  executionTime: number
  fees: {
    priorityFee: number
    protocolFee: number
    totalFee: number
  }
} 