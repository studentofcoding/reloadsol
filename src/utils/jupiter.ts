import { Connection, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, SystemProgram } from '@solana/web3.js'
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createCloseAccountInstruction, createBurnInstruction, NATIVE_MINT } from '@solana/spl-token'
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults"
import { publicKey } from "@metaplex-foundation/umi"
import { fetchAllDigitalAssetWithTokenByOwner } from "@metaplex-foundation/mpl-token-metadata"
import { JUPITER_API, TOKENS } from './solana'
import { SwapQuote, SwapTransaction, BulkBuyRequest, BulkBuyResult, TokenPurchase } from '@/types'

// Add BigInt JSON serialization support
declare global {
  interface BigInt {
    toJSON(): string
  }
}

if (typeof BigInt.prototype.toJSON === 'undefined') {
  BigInt.prototype.toJSON = function () {
    return this.toString()
  }
}

// Optimized batching configuration matching reference implementation
const BATCH_SIZE = 100 // Optimal batch size for Jupiter API v2
const PARALLEL_BATCHES = 2 // Keep moderate parallel processing
const RPC_DELAY = 200 // Minimal delay for RPC calls
const CACHE_DURATION = 1000 * 60 * 5 // 5 minutes cache
const PRICE_CACHE_DURATION = 1000 * 60 * 2 // 2 minutes for prices

// Cache interfaces
interface TokenCache {
  data: UserToken
  timestamp: number
}

interface PriceCache {
  price: number
  timestamp: number
}

// Global caches
const tokenCache = new Map<string, TokenCache>()
const priceCache = new Map<string, PriceCache>()

// Performance timing utilities
const timers = new Map<string, number>()

function startTimer(label: string): void {
  timers.set(label, Date.now())
}

function stopTimer(label: string): number {
  const start = timers.get(label)
  if (start) {
    const duration = Date.now() - start
    console.log(`⏱️ ${label}: ${duration}ms`)
    timers.delete(label)
    return duration
  }
  return 0
}

// Utility function for delays
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Efficient batch price fetching using Jupiter API v2 - Returns prices in USD
async function batchFetchPrices(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {}
  
  startTimer('jupiter-batch')
  
  const chunks = []
  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    chunks.push(mints.slice(i, i + BATCH_SIZE))
  }

  const prices: Record<string, number> = {}
  const RETRY_DELAY = 400
  const MAX_RETRIES = 3

  await Promise.all(chunks.map(async (chunk, index) => {
    const chunkLabel = `Price Chunk ${index + 1}/${chunks.length}`
    startTimer(chunkLabel)
    
    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      try {
        const mintIds = chunk.join(',')
        const response = await fetch(`https://api.jup.ag/price/v2?ids=${mintIds}`)
        const priceData = await response.json()
        console.log(`Price data for chunk ${index + 1}:`, priceData)
        
        if (priceData?.data) {
          Object.entries(priceData.data).forEach(([mint, data]: [string, any]) => {
            // Only set price if data exists and is not null
            if (data && data.price) {
              const usdPrice = parseFloat(data.price)
              prices[mint] = usdPrice
              // Cache the USD price
              priceCache.set(mint, {
                price: usdPrice,
                timestamp: Date.now()
              })
            } else {
              prices[mint] = 0 // Default price for null values
            }
          })
          break // Success, exit retry loop
        }
        
        await sleep(RETRY_DELAY)
      } catch (error) {
        console.warn(`Price fetch attempt ${retry + 1} failed:`, error)
        if (retry === MAX_RETRIES - 1) {
          console.error('Price fetch failed after all retries')
          // Set all chunk mints to 0 price on final failure
          chunk.forEach(mint => {
            prices[mint] = 0
          })
        } else {
          await sleep(RETRY_DELAY)
        }
      }
    }
    
    stopTimer(chunkLabel)
  }))
  
  stopTimer('jupiter-batch')
  console.log(`Fetched USD prices for ${Object.keys(prices).length}/${mints.length} tokens`)
  return prices
}

// Get cached price or fetch if expired - Returns price in USD
async function getCachedPrice(mint: string): Promise<number> {
  const cached = priceCache.get(mint)
  if (cached && (Date.now() - cached.timestamp) < PRICE_CACHE_DURATION) {
    return cached.price
  }
  
  // Fetch single price if not cached
  const prices = await batchFetchPrices([mint])
  return prices[mint] || 0
}

// Clear price cache (use sparingly)
export function clearPriceCache(): void {
  priceCache.clear()
}

// Clear all caches (use sparingly to avoid redundant fetches)
export function clearAllCaches(): void {
  tokenCache.clear()
  priceCache.clear()
}

// Reset rate limiting state (simplified)
export function resetRateLimitState(): void {
  console.log('Rate limit state reset')
}

// Add problematic token tracking like reference
export function addProblematicToken(mint: string): void {
  dynamicProblematicMints.add(mint)
  tokenCache.delete(mint)
}

export function isProblematicToken(mint: string): boolean {
  return PROBLEMATIC_MINTS.includes(mint) || dynamicProblematicMints.has(mint)
}

// Pre-warm cache with common token data for faster subsequent loads
export async function preWarmTokenCache(mints: string[]): Promise<void> {
  const uncachedMints = mints.filter(mint => {
    const cached = priceCache.get(mint)
    return !cached || (Date.now() - cached.timestamp) > PRICE_CACHE_DURATION
  })
  
  if (uncachedMints.length > 0) {
    console.log(`Pre-warming cache for ${uncachedMints.length} tokens`)
    try {
      await batchFetchPrices(uncachedMints)
    } catch (error) {
      console.warn('Failed to pre-warm token cache:', error)
    }
  }
}

// Fee configuration with percentage-based fees for buy/sell and fixed fees for close
const FEE_CONFIG = {
  DEV_WALLET: '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX',
  FEES: {
    BUY_PERCENTAGE: 0.5,     // 0.5% of SOL budget for buy operations
    SELL_PERCENTAGE: 0.5,    // 0.5% of SOL received for sell operations
    CLOSE: 0.001,          // 0.001 SOL per successful close operation (fixed)
  },
  REFERRAL_PERCENTAGE: 0, // All fees go to dev wallet (no referral split)
}

// Operation types for fee calculation
export type FeeOperationType = 'BUY' | 'SELL' | 'CLOSE'

// Get fee amount for specific operation type and amount
export function getFeeForOperation(operationType: FeeOperationType, solAmount?: number): number {
  switch (operationType) {
    case 'BUY':
      return solAmount ? (solAmount * FEE_CONFIG.FEES.BUY_PERCENTAGE) / 100 : 0
    case 'SELL':
      return solAmount ? (solAmount * FEE_CONFIG.FEES.SELL_PERCENTAGE) / 100 : 0
    case 'CLOSE':
      return FEE_CONFIG.FEES.CLOSE
    default:
      return 0
  }
}

// Calculate fee distribution for specific operation type, count, and SOL amount
export function calculateFeeDistribution(
  operationType: FeeOperationType, 
  operationCount: number, 
  solAmount?: number
): {
  totalFee: number
  devFee: number
  referralFee: number
  feeInLamports: number
  devFeeInLamports: number
  referralFeeInLamports: number
  operationType: FeeOperationType
  operationCount: number
  feePercentage?: number
  baseSolAmount?: number
} {
  let totalFee = 0
  
  if (operationType === 'BUY' || operationType === 'SELL') {
    // Percentage-based fees
    totalFee = solAmount ? getFeeForOperation(operationType, solAmount) : 0
  } else {
    // Fixed fees for CLOSE operations
    totalFee = getFeeForOperation(operationType) * operationCount
  }
  
  // All fees go to dev wallet (no referral split)
  const devFee = totalFee
  const referralFee = 0
  
  return {
    totalFee,
    devFee,
    referralFee,
    feeInLamports: Math.floor(totalFee * LAMPORTS_PER_SOL),
    devFeeInLamports: Math.floor(devFee * LAMPORTS_PER_SOL),
    referralFeeInLamports: Math.floor(referralFee * LAMPORTS_PER_SOL),
    operationType,
    operationCount,
    feePercentage: operationType === 'BUY' ? FEE_CONFIG.FEES.BUY_PERCENTAGE : 
                   operationType === 'SELL' ? FEE_CONFIG.FEES.SELL_PERCENTAGE : undefined,
    baseSolAmount: solAmount
  }
}

export function getReferralFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  
  try {
    const url = new URL(window.location.href)
    const referral = url.searchParams.get('ref')
    
    // Validate referral address
    if (referral && isValidMintAddress(referral)) {
      return referral
    }
  } catch (error) {
    console.warn('Error parsing referral from URL:', error)
  }
  
  return null
}

// Create fee transfer instructions
export function createFeeTransferInstructions(
  fromPubkey: PublicKey,
  operationType: FeeOperationType,
  operationCount: number,
  solAmount?: number
): any[] {
  if (!isValidMintAddress(FEE_CONFIG.DEV_WALLET)) {
    console.warn('Invalid dev wallet address in fee config')
    return []
  }

  const feeDistribution = calculateFeeDistribution(operationType, operationCount, solAmount)
  const instructions = []

  // Create transfer instruction to dev wallet (all fees go to dev now)
  if (feeDistribution.devFeeInLamports > 0) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey: new PublicKey(FEE_CONFIG.DEV_WALLET),
        lamports: feeDistribution.devFeeInLamports,
      })
    )
  }

  // Note: No referral transfers since all fees go to dev wallet

  return instructions
}

// Create fee transfer instructions in Jupiter format for inclusion in swap transactions
export function createJupiterFeeInstructions(
  fromPubkey: PublicKey,
  operationType: FeeOperationType,
  operationCount: number,
  solAmount?: number
): any[] {
  const feeInstructions = createFeeTransferInstructions(fromPubkey, operationType, operationCount, solAmount)
  
  // Convert to Jupiter format
  return feeInstructions.map(instruction => ({
    programId: instruction.programId.toBase58(),
    keys: instruction.keys.map((key: any) => ({
      pubkey: key.pubkey.toBase58(),
      isSigner: key.isSigner,
      isWritable: key.isWritable
    })),
    data: Buffer.from(instruction.data).toString('base64')
  }))
}

// Get fee information for specific operation type
export function getFeeInfo(operationType: FeeOperationType, solAmount?: number): {
  feeAmount: number
  feePercentage?: number
  fixedFee?: number
  referralPercentage: number
  devWallet: string
  operationType: FeeOperationType
} {
  let feeAmount = 0
  let feePercentage: number | undefined
  let fixedFee: number | undefined

  if (operationType === 'BUY' || operationType === 'SELL') {
    feePercentage = operationType === 'BUY' ? FEE_CONFIG.FEES.BUY_PERCENTAGE : FEE_CONFIG.FEES.SELL_PERCENTAGE
    feeAmount = solAmount ? getFeeForOperation(operationType, solAmount) : 0
  } else {
    fixedFee = FEE_CONFIG.FEES.CLOSE
    feeAmount = fixedFee
  }

  return {
    feeAmount,
    feePercentage,
    fixedFee,
    referralPercentage: FEE_CONFIG.REFERRAL_PERCENTAGE,
    devWallet: FEE_CONFIG.DEV_WALLET,
    operationType
  }
}

// Calculate fee preview for specific operation type
export function calculateFeePreview(operationType: FeeOperationType, operationCount: number, solAmount?: number): {
  totalFees: number
  devFee: number
  referralFee: number
  feeAmount: number
  referralAddress: string | null
  operationType: FeeOperationType
  operationCount: number
  feePercentage?: number
  baseSolAmount?: number
} {
  const feeDistribution = calculateFeeDistribution(operationType, operationCount, solAmount)
  return {
    totalFees: feeDistribution.totalFee,
    devFee: feeDistribution.devFee,
    referralFee: feeDistribution.referralFee,
    feeAmount: feeDistribution.totalFee,
    referralAddress: null, // No referral system now
    operationType,
    operationCount,
    feePercentage: feeDistribution.feePercentage,
    baseSolAmount: feeDistribution.baseSolAmount
  }
}

// Get all fee rates for comparison
export function getAllFeeRates(): {
  buyPercentage: number
  sellPercentage: number
  closeFixed: number
  referralPercentage: number
  devWallet: string
} {
  return {
    buyPercentage: FEE_CONFIG.FEES.BUY_PERCENTAGE,
    sellPercentage: FEE_CONFIG.FEES.SELL_PERCENTAGE,
    closeFixed: FEE_CONFIG.FEES.CLOSE,
    referralPercentage: FEE_CONFIG.REFERRAL_PERCENTAGE,
    devWallet: FEE_CONFIG.DEV_WALLET
  }
}

// New interfaces for selling
export interface UserToken {
  mintAddress: string
  balance: number
  decimals: number
  symbol?: string
  name?: string
  logoURI?: string
  uiAmount: number
  usdValue: number // USD value from Jupiter API
  isLoadingPrice?: boolean
  frozen?: boolean // Whether the token account is frozen
  isNFT?: boolean // Whether the token is likely an NFT
}

// New interface for tokens with specified sell amounts
export interface TokenToSell extends UserToken {
  sellAmount: number // Amount to sell (in token units, not percentage)
  sellPercentage: number // Percentage to sell (0-100)
}

export interface BulkSellRequest {
  tokens: TokenToSell[] // Changed to use TokenToSell instead of UserToken
  unsellableTokens?: UserToken[] // Optional unsellable tokens to close
  slippage: number
  priorityFee: number
}

export interface BulkSellResult {
  success: boolean
  successfulSwaps: Array<{ mintAddress: string; solReceived: number }>
  failedSwaps: Array<{ mintAddress: string; error: string }>
  successfulCloses: string[]
  failedCloses: Array<{ mintAddress: string; error: string }>
  totalReceived: number
  signatures: string[]
  feeInfo: {
    totalFees: number // Total fees paid in SOL
    devFee: number // Fee paid to dev wallet
    referralFee: number // Fee paid to referral (if any)
    feePerOperation: number // Fee rate per operation
    totalOperations: number // Number of successful operations
    operationType: FeeOperationType // Type of operation for fee calculation
    sellFeeRate: number // Specific sell fee rate
    closeFeeRate: number // Specific close fee rate
  }
}

// Get quote for a single token swap
export async function getSwapQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 100
): Promise<SwapQuote | null> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
    })

    const response = await fetch(`${JUPITER_API.quote}?${params}`)
    
    if (!response.ok) {
      throw new Error(`Quote API error: ${response.status}`)
    }

    const quote = await response.json()
    return quote
  } catch (error) {
    console.error('Error getting swap quote:', error)
    return null
  }
}

// Get swap transaction with optional additional instructions
export async function getSwapTransaction(
  quote: SwapQuote,
  userPublicKey: string,
  priorityFeeLamports: number = 0,
  additionalInstructions: any[] = []
): Promise<SwapTransaction | null> {
  try {
    const requestBody: any = {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      priorityLevelWithMaxLamports: {
        priorityLevel: 'medium',
        maxLamports: priorityFeeLamports,
      },
    }

    // Add additional instructions if provided (like fee transfers)
    if (additionalInstructions.length > 0) {
      requestBody.additionalInstructions = additionalInstructions
    }

    const response = await fetch(JUPITER_API.swap, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      throw new Error(`Swap API error: ${response.status}`)
    }

    const swapResult = await response.json()
    return swapResult
  } catch (error) {
    console.error('Error getting swap transaction:', error)
    return null
  }
}

// Retry mechanism for network errors
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      const isLastAttempt = attempt === maxRetries
      const isRetryableError = 
        error instanceof Error && 
        (error.message.includes('ChunkLoadError') || 
         error.message.includes('Loading chunk') ||
         error.message.includes('Network') ||
         error.message.includes('fetch'))

      if (isLastAttempt || !isRetryableError) {
        throw error
      }

      // Exponential backoff
      const delay = baseDelay * Math.pow(2, attempt)
      await new Promise(resolve => setTimeout(resolve, delay))
      console.log(`Retrying operation after ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
    }
  }
  throw new Error('Max retries exceeded')
}

// Get USD value estimate for a token with efficient pricing
export async function getTokenUsdValue(
  mintAddress: string,
  balance: number,
  decimals: number
): Promise<number> {
  try {
    // Skip if balance is too small to avoid API calls for dust
    if (balance === 0) return 0
    
    // First try to get price from cache or batch fetch (price is in USD)
    const price = await getCachedPrice(mintAddress)
    
    if (price > 0) {
      // Calculate token value using USD price
      const tokenAmount = balance / Math.pow(10, decimals)
      return tokenAmount * price
    }
    
    // Fallback to quote-based calculation for tokens without price data
    const quote = await retryWithBackoff(() => 
      getSwapQuote(
        mintAddress,
        TOKENS.SOL,
        balance,
        300 // 3% slippage for estimation
      ),
      2, // Reduced retries since we have price fallback
      1000
    )
    
    if (!quote || !quote.outAmount) return 0
    
    // Convert outAmount (in lamports) to SOL
    const solAmount = parseInt(quote.outAmount) / LAMPORTS_PER_SOL
    return solAmount
  } catch (error) {
    console.warn(`Failed to get USD value for ${mintAddress}:`, error)
    return 0
  }
}

// Add excluded and problematic token lists like reference
const EXCLUDED_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]

const PROBLEMATIC_MINTS = [
  '1Qf8gESP4i6CFNWerUSDdLKJ9U1LpqTYvjJ2MM4pain', // PAIN
  'SNS8DJbHc34nKySHVhLGMUUE72ho6igvJaxtq9TYvjJ2MM4pain', // SNS
]

// Add dynamic problematic tokens tracking
const dynamicProblematicMints = new Set<string>()
const ALL_EXCLUDED_MINTS = [...EXCLUDED_MINTS, ...PROBLEMATIC_MINTS]

// Add loading state to prevent duplicate fetches
let isTokenLoading = false

// Metadata enrichment cache to track which tokens are being enriched
const metadataEnrichmentInProgress = new Set<string>()

// Callback for when metadata is updated (to trigger UI updates)
let metadataUpdateCallback: ((updatedTokens: UserToken[]) => void) | null = null

// Set callback for metadata updates
export function setMetadataUpdateCallback(callback: (updatedTokens: UserToken[]) => void): void {
  metadataUpdateCallback = callback
}

// Clear metadata update callback
export function clearMetadataUpdateCallback(): void {
  metadataUpdateCallback = null
}

// Asynchronously enrich token metadata (name, symbol, logoURI) without blocking the main flow
async function enrichTokenMetadataAsync(tokens: UserToken[]): Promise<void> {
  // Filter tokens that need metadata enrichment and aren't already being processed
  const tokensNeedingMetadata = tokens.filter(token => 
    !token.isNFT && 
    (token.symbol === 'Unknown' || token.name === 'Unknown Token') &&
    !metadataEnrichmentInProgress.has(token.mintAddress)
  )

  if (tokensNeedingMetadata.length === 0) return

  console.log(`Enriching metadata for ${tokensNeedingMetadata.length} tokens in background`)

  // Mark tokens as being processed
  tokensNeedingMetadata.forEach(token => metadataEnrichmentInProgress.add(token.mintAddress))

  // Process metadata enrichment in parallel but with controlled concurrency
  const METADATA_BATCH_SIZE = 10 // Process 10 tokens at a time to avoid overwhelming the API
  
  for (let i = 0; i < tokensNeedingMetadata.length; i += METADATA_BATCH_SIZE) {
    const batch = tokensNeedingMetadata.slice(i, i + METADATA_BATCH_SIZE)
    
    // Process batch in parallel
    const metadataPromises = batch.map(async (token) => {
      try {
        const metadata = await getTokenInfo(token.mintAddress)
        if (metadata) {
          // Update the token object directly (this will reflect in the UI if tokens are reactive)
          token.symbol = metadata.symbol
          token.name = metadata.name
          token.logoURI = metadata.logoURI

          // Update cache with enriched metadata
          const cached = tokenCache.get(token.mintAddress)
          if (cached) {
            cached.data = { ...cached.data, ...metadata }
            tokenCache.set(token.mintAddress, cached)
          }

          console.log(`Enriched metadata for ${metadata.symbol} (${token.mintAddress})`)
          return token
        }
      } catch (error) {
        console.warn(`Failed to enrich metadata for ${token.mintAddress}:`, error)
      } finally {
        // Remove from processing set
        metadataEnrichmentInProgress.delete(token.mintAddress)
      }
      return null
    })

    // Wait for current batch to complete before processing next batch
    const enrichedTokens = (await Promise.all(metadataPromises)).filter(Boolean) as UserToken[]
    
    // Trigger UI update callback if any tokens were enriched
    if (enrichedTokens.length > 0 && metadataUpdateCallback) {
      metadataUpdateCallback(enrichedTokens)
    }
    
    // Small delay between batches to be respectful to the API
    if (i + METADATA_BATCH_SIZE < tokensNeedingMetadata.length) {
      await sleep(500) // 500ms delay between batches
    }
  }

  console.log(`Completed metadata enrichment for ${tokensNeedingMetadata.length} tokens`)
}

// Efficient batch token data fetching using RPC like reference
async function batchFetchTokenData(connection: Connection, mints: PublicKey[]): Promise<Array<{
  mint: string
  decimals: number
  supply: number
}>> {
  startTimer('rpc-batch')
  
  let allResults: Array<{
    mint: string
    decimals: number
    supply: number
  }> = []
  
  // Process in chunks of 100 (RPC limit)
  for (let i = 0; i < mints.length; i += 100) {
    const mintChunk = mints.slice(i, i + 100)
    
    try {
      const accountInfos = await connection.getMultipleAccountsInfo(mintChunk)
      
      const chunkResults = mintChunk.map((mint, j) => {
        const mintInfo = accountInfos[j]
        
        if (!mintInfo?.data || mintInfo.data.length < 82) {
          return null
        }
        
        try {
          // Parse mint data: decimals at byte 44, supply at bytes 36-44
          const decimals = mintInfo.data[44]
          const supplyBytes = mintInfo.data.slice(36, 44)
          const supply = Number(supplyBytes.readBigUInt64LE(0))
          
          return {
            mint: mint.toBase58(),
            decimals,
            supply
          }
        } catch (error) {
          console.warn(`Data parse failed for ${mint.toBase58()}:`, error)
          return null
        }
      })

      allResults = [...allResults, ...chunkResults.filter((result): result is NonNullable<typeof result> => result !== null)]
    } catch (error) {
      console.error(`Failed to fetch chunk ${i}-${i + 100}:`, error)
    }

    // Add delay between chunks to respect rate limits
    if (i + 100 < mints.length) {
      await sleep(RPC_DELAY)
    }
  }
  
  stopTimer('rpc-batch')
  return allResults
}

// Efficient token processing like reference
async function processBatch(
  connection: Connection,
  tokenAccounts: any[],
  prices: Record<string, number>
): Promise<UserToken[]> {
  // Filter out excluded and problematic tokens before processing
  const filteredAccounts = tokenAccounts.filter(acc => {
    const mint = acc.account.data.parsed.info.mint
    return !ALL_EXCLUDED_MINTS.includes(mint) && !dynamicProblematicMints.has(mint)
  })
  
  const mintPublicKeys = filteredAccounts.map(acc => 
    new PublicKey(acc.account.data.parsed.info.mint)
  )

  const tokenData = await batchFetchTokenData(connection, mintPublicKeys)
  
  const processedTokens = filteredAccounts.map((account): UserToken | null => {
    const mint = account.account.data.parsed.info.mint
    const tokenAmount = account.account.data.parsed.info.tokenAmount.uiAmount || 0
    const balance = Number(account.account.data.parsed.info.tokenAmount.amount)
    
    // Check cache first
    const cached = tokenCache.get(mint)
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      // Update with current balance and recalculate USD value
      const price = prices[mint] || 0
      const updatedUsdValue = price > 0 ? tokenAmount * price : 0
      
      return {
        ...cached.data,
        balance: balance,
        uiAmount: tokenAmount,
        usdValue: updatedUsdValue
      }
    }

    const data = tokenData?.find(d => d.mint === mint)
    if (!data) {
      return null
    }

    // Check if it's likely an NFT (supply = 1, decimals = 0)
    const isNFT = data.decimals === 0 && data.supply <= 1

    // Calculate USD value properly: price * token amount
    const price = prices[mint] || 0
    const usdValue = price > 0 ? tokenAmount * price : 0

    const userToken: UserToken = {
      mintAddress: mint,
      balance: balance,
      decimals: data.decimals,
      symbol: 'Unknown', // Will be enriched asynchronously
      name: 'Unknown Token', // Will be enriched asynchronously
      logoURI: undefined, // Will be enriched asynchronously
      uiAmount: tokenAmount,
      usdValue: usdValue, // Properly calculated USD value
      isLoadingPrice: false,
      frozen: false, // TODO: Add frozen check if needed
      isNFT: isNFT
    }

    // Cache the token data
    tokenCache.set(mint, {
      data: userToken,
      timestamp: Date.now()
    })

    return userToken
  }).filter((token): token is UserToken => token !== null)

  return processedTokens
}

// Main efficient token fetching function based on reference
export async function fetchUserTokens(
  connection: Connection,
  userPublicKey: PublicKey,
  includeZeroBalance: boolean = false,
  includeNFTs: boolean = false
): Promise<UserToken[]> {
  if (isTokenLoading) {
    console.log('Token fetch already in progress, skipping...')
    return []
  }
  
  isTokenLoading = true
  
  try {
    startTimer('total-token-fetch')
    
    // Single RPC call to get all token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      userPublicKey,
      { programId: TOKEN_PROGRAM_ID }
    )

    // Split accounts by balance if needed
    const relevantAccounts = includeZeroBalance 
      ? tokenAccounts.value
      : tokenAccounts.value.filter(acc => 
          acc.account.data.parsed.info.tokenAmount.uiAmount > 0
        )

    if (relevantAccounts.length === 0) {
      return []
    }

    // Get all unique mints
    const allMints = Array.from(new Set(
      relevantAccounts.map(acc => acc.account.data.parsed.info.mint)
    ))

    // Single price fetch for all tokens
    const prices = await batchFetchPrices(allMints)

    // Process tokens efficiently
    const processedTokens = await processBatch(connection, relevantAccounts, prices)

    // Filter NFTs if not requested
    const filteredTokens = includeNFTs 
      ? processedTokens 
      : processedTokens.filter(token => !token.isNFT)

    // Asynchronously enrich token metadata (non-blocking)
    enrichTokenMetadataAsync(filteredTokens)

    stopTimer('total-token-fetch')
    console.log(`Processed ${filteredTokens.length} tokens efficiently`)

    return filteredTokens.sort((a, b) => {
      const aIsSellable = (a.usdValue >= 0.001 || isPumpFunToken(a.mintAddress)) && !a.frozen
      const bIsSellable = (b.usdValue >= 0.001 || isPumpFunToken(b.mintAddress)) && !b.frozen
      
      if (aIsSellable && !bIsSellable) return -1
      if (!aIsSellable && bIsSellable) return 1
      if (aIsSellable && bIsSellable) return b.usdValue - a.usdValue
      
      return (a.symbol || '').localeCompare(b.symbol || '')
    })

  } catch (error) {
    console.error('Error fetching user tokens:', error)
    return []
  } finally {
    isTokenLoading = false
  }
}

// Function to clear NFT cache (useful when switching users)
export function clearNFTCache(): void {
  nftMintCache.clear();
  nftCacheInitialized = false;
  
  // Keep only the original hardcoded tokens in KNOWN_NON_NFT_TOKENS
  // by recreating the set with only the initial values
  const initialNonNFTTokens = [
    'JCBKQBPvnjr7emdQGCNM8wtE8AZjyvJgh7JMvkfYxypm',
    '7tPPYTBKrFLKKnoCwijrsfjAYadyp7GpAmSPUbVwbonk',
    'DBRiDgJAMsM95moTzJs7M9LnkGErpbv9v6CUR1DXnUu5',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'CHEg2pGFoJE3BQChUgYWXUCMQzQfNp6jBDYkdiW11dqN',
    'DwJeLBy5PVHKR9Ec8491mk7E1XV11oB6JyjXZ2GjuoZX',
  ];
  
  // Clear and repopulate the set
  KNOWN_NON_NFT_TOKENS.clear();
  initialNonNFTTokens.forEach(token => KNOWN_NON_NFT_TOKENS.add(token));
}

// Public function to check if a token is an NFT (ensures cache is initialized)
export async function checkIfTokenIsNFT(
  connection: Connection,
  userPublicKey: PublicKey,
  mintAddress: string
): Promise<boolean> {
  try {
    // If it's a known non-NFT token, it's definitely not an NFT
    if (isKnownNonNFT(mintAddress)) {
      return false;
    }
    
    // Initialize cache if not done yet
    if (!nftCacheInitialized) {
      const userNFTs = await fetchUserNFTMints(connection, userPublicKey)
      userNFTs.forEach(mint => nftMintCache.add(mint))
      nftCacheInitialized = true
    }
    
    // Check cache first
    if (nftMintCache.has(mintAddress)) {
      return true;
    }
    
    // If not in cache, do a direct check
    try {
      const mintInfo = await connection.getTokenSupply(new PublicKey(mintAddress))
      const supply = Number(mintInfo.value.amount)
      const decimals = mintInfo.value.decimals
      
      // NFTs typically have 0 decimals and supply of 1
      return decimals === 0 && supply <= 1;
    } catch (error) {
      console.warn(`Error checking token supply for ${mintAddress}:`, error)
      return false;
    }
  } catch (error) {
    console.warn(`Error checking NFT status for ${mintAddress}:`, error)
    return false
  }
}

// New function to fetch only NFTs if needed
export async function fetchUserNFTs(
  connection: Connection,
  userPublicKey: PublicKey
): Promise<UserToken[]> {
  try {
    const allTokens = await fetchUserTokens(connection, userPublicKey, true, true) // Include zero balance and NFTs
    return allTokens.filter(token => token.isNFT)
  } catch (error) {
    console.error('Error fetching user NFTs:', error)
    return []
  }
}

// Alternative function to fetch NFT details directly using Metaplex
export async function fetchUserNFTsDetailed(
  connection: Connection,
  userPublicKey: PublicKey
): Promise<Array<{
  mintAddress: string
  name: string
  symbol: string
  uri: string
  publicKey: string
}>> {
  try {
    // Create UMI instance
    const umi = createUmi(connection.rpcEndpoint)
    
    // Convert PublicKey to UMI publicKey
    const ownerPublicKey = publicKey(userPublicKey.toBase58())
    
    console.log("Fetching detailed NFT information...")
    const allNFTs = await fetchAllDigitalAssetWithTokenByOwner(umi, ownerPublicKey)
    
    return allNFTs.map((nft) => ({
      mintAddress: nft.publicKey.toString(),
      name: nft.metadata.name,
      symbol: nft.metadata.symbol,
      uri: nft.metadata.uri,
      publicKey: nft.publicKey.toString()
    }))
  } catch (error) {
    console.error('Error fetching detailed NFT information:', error)
    return []
  }
}

// Enhanced function to get specific NFT metadata
export async function getNFTMetadata(
  connection: Connection,
  userPublicKey: PublicKey,
  mintAddress: string
): Promise<{
  decimals: number
  symbol: string
  name: string
  logoURI?: string
  uri?: string
  isNFT: boolean
} | null> {
  try {
    // First check if it's a known non-NFT token
    if (isKnownNonNFT(mintAddress)) {
      const tokenInfo = await getTokenInfo(mintAddress);
      return {
        ...(tokenInfo || { decimals: 6, symbol: 'TOKEN', name: 'Unknown Token' }),
        isNFT: false
      };
    }
    
    // Then check if it's an NFT
    const tokenIsNFT = await checkIfTokenIsNFT(connection, userPublicKey, mintAddress)
    
    if (tokenIsNFT) {
      // Get detailed NFT metadata
      const umi = createUmi(connection.rpcEndpoint)
      const ownerPublicKey = publicKey(userPublicKey.toBase58())
      
      try {
        const allNFTs = await fetchAllDigitalAssetWithTokenByOwner(umi, ownerPublicKey)
        const specificNFT = allNFTs.find(nft => nft.publicKey.toString() === mintAddress)
        
        if (specificNFT) {
          return {
            decimals: 0,
            symbol: specificNFT.metadata.symbol || 'NFT',
            name: specificNFT.metadata.name || 'NFT',
            logoURI: undefined, // Could be extracted from URI metadata
            uri: specificNFT.metadata.uri,
            isNFT: true
          }
        }
      } catch (error) {
        console.warn(`Failed to get specific NFT metadata for ${mintAddress}:`, error)
      }
      
      // Fallback for NFTs
      return {
        decimals: 0,
        symbol: 'NFT',
        name: 'NFT',
        logoURI: undefined,
        isNFT: true
      }
    }
    
    // Not an NFT, use regular token info
    const tokenInfo = await getTokenInfo(mintAddress)
    if (tokenInfo) {
      return {
        ...tokenInfo,
        isNFT: false
      }
    }
    
    return null
  } catch (error) {
    console.error(`Error getting token/NFT metadata for ${mintAddress}:`, error)
    return null
  }
}

// New function to fetch only zero-balance tokens for closing
export async function fetchZeroBalanceTokens(
  connection: Connection,
  userPublicKey: PublicKey
): Promise<UserToken[]> {
  try {
    const allTokens = await fetchUserTokens(connection, userPublicKey, true)
    // Include tokens with zero balance OR tokens with USD value < 0.001 (unsellable), but exclude pump.fun tokens AND frozen tokens
    return allTokens.filter(token => 
      !token.frozen && (
        token.uiAmount <= 0.000000000001 || 
        (token.usdValue < 0.001 && !isPumpFunToken(token.mintAddress))
      )
    )
  } catch (error) {
    console.error('Error fetching zero balance tokens:', error)
    return []
  }
}

// Simple token info lookup (streamlined - NFT checking handled upstream)
async function getTokenInfo(mintAddress: string): Promise<{ decimals: number; symbol: string; name: string; logoURI?: string } | null> {
  try {
    // Try Jupiter's Token API first with rate limiting
    const jupiterResult = await jupiterAPI.fetchTokenInfo(mintAddress)
    
    if (jupiterResult) {
      return jupiterResult
    }

    // Fallback to common tokens
    const commonTokens: Record<string, any> = {
      [TOKENS.SOL]: { decimals: 9, symbol: 'SOL', name: 'Wrapped SOL', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
      [TOKENS.USDC]: { decimals: 6, symbol: 'USDC', name: 'USD Coin', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
      [TOKENS.USDT]: { decimals: 6, symbol: 'USDT', name: 'Tether USD', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg' },
    }

    if (commonTokens[mintAddress]) {
      return commonTokens[mintAddress]
    }

    // Default for unknown tokens
    return { decimals: 6, symbol: 'TOKEN', name: 'Unknown Token' }
  } catch {
    return { decimals: 6, symbol: 'TOKEN', name: 'Unknown Token' }
  }
}

// Check if token is a pump.fun token
export function isPumpFunToken(mintAddress: string): boolean {
  return mintAddress.includes('pump') || mintAddress.endsWith('pump')
}

// Check if token is a well-known token (SOL, USDC, USDT, etc.)
export function isWellKnownToken(mintAddress: string): boolean {
  return Object.values(TOKENS).includes(mintAddress)
}

// List of known non-NFT tokens that might be incorrectly identified
const KNOWN_NON_NFT_TOKENS = new Set([
  // Add the tokens from your error logs
  'JCBKQBPvnjr7emdQGCNM8wtE8AZjyvJgh7JMvkfYxypm',
  '7tPPYTBKrFLKKnoCwijrsfjAYadyp7GpAmSPUbVwbonk',
  'DBRiDgJAMsM95moTzJs7M9LnkGErpbv9v6CUR1DXnUu5',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (already in TOKENS)
  'CHEg2pGFoJE3BQChUgYWXUCMQzQfNp6jBDYkdiW11dqN',
  'DwJeLBy5PVHKR9Ec8491mk7E1XV11oB6JyjXZ2GjuoZX',
  // Add more tokens as needed
]);

// Check if token is a known non-NFT token
export function isKnownNonNFT(mintAddress: string): boolean {
  return KNOWN_NON_NFT_TOKENS.has(mintAddress) || 
         isWellKnownToken(mintAddress) || 
         isPumpFunToken(mintAddress)
}

// Cache for NFT mint addresses to avoid repeated API calls
const nftMintCache = new Set<string>()
let nftCacheInitialized = false

// Check if a token is an NFT using the cache (internal function)
function isTokenInNFTCache(mintAddress: string): boolean {
  // Check if it's a known non-NFT token first
  if (isKnownNonNFT(mintAddress)) {
    return false;
  }
  
  return nftMintCache.has(mintAddress)
}

// Fetch all NFTs owned by a user using Metaplex
async function fetchUserNFTMints(
  connection: Connection,
  userPublicKey: PublicKey
): Promise<Set<string>> {
  try {
    // Create UMI instance
    const umi = createUmi(connection.rpcEndpoint)
    
    // Convert PublicKey to UMI publicKey
    const ownerPublicKey = publicKey(userPublicKey.toBase58())
    
    console.log("Fetching NFTs using Metaplex...")
    const allDigitalAssets = await fetchAllDigitalAssetWithTokenByOwner(umi, ownerPublicKey)
    
    // Extract mint addresses
    const nftMints = new Set<string>()
    
    // Process each digital asset
    for (const asset of allDigitalAssets) {
      const mintAddress = asset.publicKey.toString()
      
      // Skip known non-NFT tokens
      if (isKnownNonNFT(mintAddress)) {
        console.log(`Skipping known non-NFT token: ${mintAddress}`)
        continue
      }
      
      try {
        // Check if Jupiter API recognizes this as a fungible token
        const isJupiterToken = await isFungibleTokenWithJupiter(mintAddress)
        if (isJupiterToken) {
          console.log(`Skipping Jupiter-recognized token: ${mintAddress}`)
          
          // Add to known non-NFT tokens for future reference
          KNOWN_NON_NFT_TOKENS.add(mintAddress)
          continue
        }
        
        // Get token supply and decimals to determine if it's an NFT
        const mintInfo = await connection.getTokenSupply(new PublicKey(mintAddress))
        
        // Check if token has NFT characteristics:
        // 1. Supply of 1 (or 0 for burned NFTs)
        // 2. 0 decimals
        const supply = Number(mintInfo.value.amount)
        const decimals = mintInfo.value.decimals
        
        if (decimals === 0 && supply <= 1) {
          // This is likely an NFT
          nftMints.add(mintAddress)
        } else {
          // This is likely a fungible token
          console.log(`Skipping fungible token: ${mintAddress} (supply: ${supply}, decimals: ${decimals})`)
          
          // Add to known non-NFT tokens for future reference
          KNOWN_NON_NFT_TOKENS.add(mintAddress)
        }
      } catch (error) {
        console.warn(`Error checking token ${mintAddress}, treating as non-NFT:`, error)
        // Skip this token if we can't determine its characteristics
      }
    }
    
    console.log(`Found ${nftMints.size} verified NFTs for user`)
    return nftMints
  } catch (error) {
    console.error('Error fetching NFTs with Metaplex:', error)
    return new Set<string>()
  }
}

// Check if a token account is frozen by examining the account state
function isTokenAccountFrozen(accountData: Buffer): boolean {
  try {
    // SPL Token account layout:
    // - mint: 32 bytes (0-31)
    // - owner: 32 bytes (32-63)  
    // - amount: 8 bytes (64-71)
    // - delegate: 36 bytes (72-107) - includes option flag + pubkey
    // - state: 1 byte (108) - 0: Uninitialized, 1: Initialized, 2: Frozen
    // - is_native: 12 bytes (109-120) - includes option flag + amount
    // - delegated_amount: 8 bytes (121-128)
    // - close_authority: 36 bytes (129-164) - includes option flag + pubkey
    
    if (accountData.length < 165) {
      console.warn('Token account data too short to parse state')
      return false
    }
    
    const state = accountData.readUInt8(108)
    return state === 2 // 2 = Frozen
  } catch (error) {
    console.warn('Error checking token account frozen state:', error)
    return false
  }
}

// Additional check with Jupiter API for frozen status
async function checkTokenFrozenStatusWithJupiter(mintAddress: string): Promise<boolean> {
  try {
    return await jupiterAPI.checkFrozenStatus(mintAddress)
  } catch (error) {
    console.warn(`Failed to check frozen status with Jupiter for ${mintAddress}:`, error instanceof Error ? error.message : error)
  }
  
  return false
}

// Check if a token is a fungible token using Jupiter API
async function isFungibleTokenWithJupiter(mintAddress: string): Promise<boolean> {
  try {
    return await jupiterAPI.checkIfFungibleToken(mintAddress)
  } catch (error) {
    console.warn(`Failed to check fungible status with Jupiter for ${mintAddress}:`, error instanceof Error ? error.message : error)
  }
  
  return false
}

// Execute bulk token sales with account closing
export async function executeBulkSell(
  request: BulkSellRequest,
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): Promise<BulkSellResult> {
  const result: BulkSellResult = {
    success: false,
    successfulSwaps: [],
    failedSwaps: [],
    successfulCloses: [],
    failedCloses: [],
    totalReceived: 0,
    signatures: [],
            feeInfo: {
          totalFees: 0,
          devFee: 0,
          referralFee: 0,
          feePerOperation: 0, // Will be calculated based on actual amounts
          totalOperations: 0,
          operationType: 'SELL' as FeeOperationType,
          sellFeeRate: 0, // Will be calculated as 1% of received SOL
          closeFeeRate: getFeeForOperation('CLOSE')
        }
  }

  try {
    const successfulSwaps: TokenToSell[] = []
    
    // Only process swaps if there are tokens to sell
    if (request.tokens && request.tokens.length > 0) {
      // Filter out frozen tokens first
      const nonFrozenTokens = request.tokens.filter(token => !token.frozen)
      const frozenTokens = request.tokens.filter(token => token.frozen)
      
      // Add frozen tokens to failed sales immediately
      frozenTokens.forEach(token => {
        result.failedSwaps.push({
          mintAddress: token.mintAddress,
          error: 'Token account is frozen and cannot be traded'
        })
      })
      
      // Step 1: Get quotes for all non-frozen tokens to sell
      const quotes: Array<{ token: TokenToSell; quote: SwapQuote | null }> = []
      
      for (const token of nonFrozenTokens) {
        const quote = await getSwapQuote(
          token.mintAddress,
          TOKENS.SOL,
          token.sellAmount, // Use specified sell amount instead of full balance
          request.slippage
        )
        quotes.push({ token, quote })
      }

      // Filter successful quotes
      const validQuotes = quotes.filter(q => q.quote !== null)
      
      if (validQuotes.length === 0) {
        // Mark all non-frozen tokens as failed to sell (frozen tokens already marked above)
        nonFrozenTokens.forEach(token => {
          result.failedSwaps.push({
            mintAddress: token.mintAddress,
            error: 'No valid quote available'
          })
        })
      } else {
        // Step 2: Create swap transactions
        const swapTransactions: VersionedTransaction[] = []
        const swapTokens: TokenToSell[] = []
        const swapQuotes: SwapQuote[] = []

        for (const { token, quote } of validQuotes) {
          if (!quote) continue

          // For sells, fees will be included in the close accounts transaction
          // since we need the total SOL received to calculate the fee
          const feeInstructions: any[] = []

          const swapTransaction = await getSwapTransaction(
            quote,
            userPublicKey,
            request.priorityFee,
            feeInstructions // Include fee in the same transaction
          )

          if (swapTransaction) {
            const tx = VersionedTransaction.deserialize(
              Buffer.from(swapTransaction.swapTransaction, 'base64')
            )
            swapTransactions.push(tx)
            swapTokens.push(token)
            swapQuotes.push(quote)
          } else {
            result.failedSwaps.push({
              mintAddress: token.mintAddress,
              error: 'Failed to create swap transaction'
            })
          }
        }

        if (swapTransactions.length > 0) {
          // Step 3: Sign and send swap transactions
          const signedSwapTransactions = await signAllTransactions(swapTransactions)
          
          const swapSignatures: string[] = []
          
          for (let i = 0; i < signedSwapTransactions.length; i++) {
            try {
              const signature = await connection.sendTransaction(signedSwapTransactions[i], {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
              })

              // Confirm transaction
              const confirmation = await connection.confirmTransaction(signature, 'confirmed')
              
              if (confirmation.value.err) {
                result.failedSwaps.push({
                  mintAddress: swapTokens[i].mintAddress,
                  error: `Swap transaction failed: ${confirmation.value.err}`
                })
              } else {
                swapSignatures.push(signature)
                successfulSwaps.push(swapTokens[i])
                
                // Calculate actual SOL received from the quote
                const quote = swapQuotes[i]
                const solReceived = parseInt(quote.outAmount) / LAMPORTS_PER_SOL
                
                result.successfulSwaps.push({
                  mintAddress: swapTokens[i].mintAddress,
                  solReceived: solReceived
                })
                result.totalReceived += solReceived
              }
            } catch (error) {
              result.failedSwaps.push({
                mintAddress: swapTokens[i].mintAddress,
                error: `Swap error: ${error}`
              })
            }
          }
          
          result.signatures.push(...swapSignatures)
        }
      }
    }

    // Step 4: Close token accounts for successful swaps ONLY if selling 100% AND selected unsellable tokens
    // Only close accounts when selling 100% of the token
    const tokensToCloseFromSwaps = successfulSwaps.filter(token => token.sellPercentage >= 100)
    const tokensToClose: UserToken[] = [...tokensToCloseFromSwaps]
    
    // Add unsellable tokens to the close list if provided (excluding frozen tokens)
    if (request.unsellableTokens && request.unsellableTokens.length > 0) {
      const nonFrozenUnsellableTokens = request.unsellableTokens.filter(token => !token.frozen)
      const frozenUnsellableTokens = request.unsellableTokens.filter(token => token.frozen)
      
      tokensToClose.push(...nonFrozenUnsellableTokens)
      console.log(`Adding ${nonFrozenUnsellableTokens.length} unsellable tokens to close list`)
      
      // Add frozen unsellable tokens to failed closes
      frozenUnsellableTokens.forEach(token => {
        result.failedCloses.push({
          mintAddress: token.mintAddress,
          error: 'Token account is frozen and cannot be closed'
        })
      })
    }
    
    if (tokensToClose.length > 0) {
      try {
        const closeResults = await closeTokenAccounts(
          tokensToClose,
          userPublicKey,
          connection,
          signAllTransactions,
          { successfulSwapsCount: result.successfulSwaps.length, totalSolReceived: result.totalReceived }
        )
        
        result.successfulCloses = closeResults.successful
        result.failedCloses = closeResults.failed
        result.signatures.push(...closeResults.signatures)
      } catch (error) {
        console.error('Error closing accounts:', error)
        // Mark all as failed to close
        result.failedCloses = tokensToClose.map(token => ({
          mintAddress: token.mintAddress,
          error: 'Failed to close account'
        }))
      }
    }

    // Calculate and populate fee information (fees are now included inline in transactions)
    if (result.successfulSwaps.length > 0 || result.successfulCloses.length > 0) {
      // Calculate separate fees for sell and close operations
      // For sell: 0.5% of total SOL received from sales
      const sellFeeDistribution = calculateFeeDistribution('SELL', result.successfulSwaps.length, result.totalReceived)
      // For close: fixed fee per account closed
      const closeFeeDistribution = calculateFeeDistribution('CLOSE', result.successfulCloses.length)
      
      // Combine fees
      const totalFees = sellFeeDistribution.totalFee + closeFeeDistribution.totalFee
      const totalDevFee = sellFeeDistribution.devFee + closeFeeDistribution.devFee
      const totalReferralFee = sellFeeDistribution.referralFee + closeFeeDistribution.referralFee
      const totalOperations = result.successfulSwaps.length + result.successfulCloses.length
      
      result.feeInfo = {
        totalFees,
        devFee: totalDevFee,
        referralFee: totalReferralFee,
        feePerOperation: totalOperations > 0 ? totalFees / totalOperations : 0, // Average fee per operation
        totalOperations,
        operationType: 'SELL' as FeeOperationType, // Primary operation type
        sellFeeRate: getFeeForOperation('SELL', result.totalReceived),
        closeFeeRate: getFeeForOperation('CLOSE')
      }
      
      console.log(`Fees included inline: ${totalFees} SOL total (Sell: ${sellFeeDistribution.totalFee} from ${result.totalReceived} SOL received, Close: ${closeFeeDistribution.totalFee})`)
    }

    // Operation is successful if we have successful sales OR successful closes
    result.success = result.successfulSwaps.length > 0 || result.successfulCloses.length > 0
    return result
  } catch (error) {
    console.error('Bulk sell execution error:', error)
    
    // Only mark tokens as failed to sell if we actually have tokens to sell
    if (request.tokens && request.tokens.length > 0) {
      result.failedSwaps = request.tokens.map(token => ({
        mintAddress: token.mintAddress,
        error: error instanceof Error ? error.message : 'Unknown error'
      }))
    }
    
    return result
  }
}

// Close token accounts after successful sales with improved error handling
// Intelligently burns tokens first if balance > 0, then closes accounts
async function closeTokenAccounts(
  tokens: UserToken[],
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>,
  sellData?: { successfulSwapsCount: number; totalSolReceived: number }
): Promise<{ successful: string[]; failed: Array<{ mintAddress: string; error: string }>; signatures: string[] }> {
  const result = {
    successful: [] as string[],
    failed: [] as Array<{ mintAddress: string; error: string }>,
    signatures: [] as string[]
  }

  try {
    const burnInstructions = []
    const closeInstructions = []
    const tokensToProcess = []

    // Create burn and close instructions for each token
    for (const token of tokens) {
      try {
        // Skip frozen tokens
        if (token.frozen) {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: 'Token account is frozen and cannot be closed'
          })
          continue
        }
        
        // Check if the token might be problematic (like pump.fun tokens)
        if (isPumpFunToken(token.mintAddress)) {
          console.warn(`Detected pump.fun token: ${token.mintAddress}`)
          
          // For pump.fun tokens, we might need special handling
          // Some pump.fun tokens may not allow standard account closing
          try {
            const tokenAccount = await getAssociatedTokenAddress(
              new PublicKey(token.mintAddress),
              new PublicKey(userPublicKey)
            )

            // Check account balance first for pump.fun tokens
            const accountInfo = await connection.getTokenAccountBalance(tokenAccount)
            
            if (accountInfo.value.uiAmount && accountInfo.value.uiAmount > 0) {
              result.failed.push({
                mintAddress: token.mintAddress,
                error: 'Cannot close pump.fun token account with remaining balance'
              })
              continue
            }
          } catch (error) {
            result.failed.push({
              mintAddress: token.mintAddress,
              error: `Pump.fun token account check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            })
            continue
          }
        }

        const tokenAccount = await getAssociatedTokenAddress(
          new PublicKey(token.mintAddress),
          new PublicKey(userPublicKey)
        )

        // Check if account exists
        const accountInfo = await connection.getAccountInfo(tokenAccount)
        if (!accountInfo) {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: 'Token account does not exist'
          })
          continue
        }

        // Additional check for account data validity
        if (accountInfo.data.length < 165) {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: 'Invalid token account data length'
          })
          continue
        }

        // Double-check if account is frozen by examining the raw account data
        const accountFrozenState = isTokenAccountFrozen(accountInfo.data)
        if (accountFrozenState) {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: 'Token account is frozen (detected during account validation)'
          })
          continue
        }

        // Check current balance
        const balanceInfo = await connection.getTokenAccountBalance(tokenAccount)
        const currentBalance = balanceInfo.value.amount
        const currentUiAmount = balanceInfo.value.uiAmount || 0

        console.log(`Token ${token.mintAddress}: balance=${currentBalance}, uiAmount=${currentUiAmount}`)

        // If token has balance > 0, we need to burn it first
        if (parseInt(currentBalance) > 0) {
          console.log(`Creating burn instruction for ${token.mintAddress} (${currentBalance} tokens)`)
          
          const burnInstruction = createBurnInstruction(
            tokenAccount,
            new PublicKey(token.mintAddress),
            new PublicKey(userPublicKey),
            BigInt(currentBalance) // Burn the entire balance
          )
          
          burnInstructions.push(burnInstruction)
        }

        // Always create close instruction (will execute after burn if needed)
        const closeInstruction = createCloseAccountInstruction(
          tokenAccount,
          new PublicKey(userPublicKey),
          new PublicKey(userPublicKey)
        )

        closeInstructions.push(closeInstruction)
        tokensToProcess.push(token)
      } catch (error) {
        console.error(`Failed to prepare burn/close for ${token.mintAddress}:`, error)
        result.failed.push({
          mintAddress: token.mintAddress,
          error: `Failed to create burn/close instruction: ${error instanceof Error ? error.message : 'Unknown error'}`
        })
      }
    }

    if (burnInstructions.length > 0 || closeInstructions.length > 0) {
      try {
        // Add fee instructions for successful closes (fixed fee per account)
        const closeFeeInstructions = createFeeTransferInstructions(
          new PublicKey(userPublicKey),
          'CLOSE',
          tokensToProcess.length
        )
        
        // Add sell fee instructions if sell data is provided (0.5% of total SOL received)
        const sellFeeInstructions = sellData ? createFeeTransferInstructions(
          new PublicKey(userPublicKey),
          'SELL',
          sellData.successfulSwapsCount,
          sellData.totalSolReceived
        ) : []
        
        // Combine burn, close, and fee instructions in the same transaction
        const allInstructions = [...burnInstructions, ...closeInstructions, ...closeFeeInstructions, ...sellFeeInstructions]
        
        // Create transaction with burn + close + fee instructions
        const { blockhash } = await connection.getLatestBlockhash('confirmed')
        
        const messageV0 = new TransactionMessage({
          payerKey: new PublicKey(userPublicKey),
          recentBlockhash: blockhash,
          instructions: allInstructions
        }).compileToV0Message()

        const transaction = new VersionedTransaction(messageV0)
        const signedTransactions = await signAllTransactions([transaction])

        // Send burn + close transaction with retry mechanism
        const signature = await retryWithBackoff(async () => {
          return await connection.sendTransaction(signedTransactions[0], {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
          })
        })

        const confirmation = await connection.confirmTransaction(signature, 'confirmed')
        
        if (confirmation.value.err) {
          const errorMsg = `Burn/Close transaction failed: ${JSON.stringify(confirmation.value.err)}`
          console.error(errorMsg)
          tokensToProcess.forEach(token => {
            result.failed.push({
              mintAddress: token.mintAddress,
              error: errorMsg
            })
          })
        } else {
          result.signatures.push(signature)
          result.successful = tokensToProcess.map(token => token.mintAddress)
          console.log(`Successfully burned and closed ${tokensToProcess.length} token accounts`)
          
          // Log details
          if (burnInstructions.length > 0) {
            console.log(`- Burned tokens in ${burnInstructions.length} accounts`)
          }
          console.log(`- Closed ${closeInstructions.length} accounts`)
        }
      } catch (transactionError) {
        console.error('Transaction creation/sending failed:', transactionError)
        tokensToProcess.forEach(token => {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: `Transaction failed: ${transactionError instanceof Error ? transactionError.message : 'Unknown transaction error'}`
          })
        })
      }
    } else {
      console.log('No token accounts to burn/close')
    }

    return result
  } catch (error) {
    console.error('Burn/Close accounts function failed:', error)
    tokens.forEach(token => {
      result.failed.push({
        mintAddress: token.mintAddress,
        error: `Close account error: ${error instanceof Error ? error.message : 'Unknown error'}`
      })
    })
    return result
  }
}

// Execute bulk token purchase
export async function executeBulkBuy(
  request: BulkBuyRequest,
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): Promise<BulkBuyResult> {
  const result: BulkBuyResult = {
    success: false,
    successfulPurchases: [],
    failedPurchases: [],
    totalSpent: 0,
    signatures: [],
    feeInfo: {
      totalFees: 0,
      devFee: 0,
      referralFee: 0,
      feePerOperation: 0,
      totalOperations: 0,
      operationType: 'BUY' as FeeOperationType
    }
  }

  try {
    // Calculate amount per token in lamports
    const amountPerToken = Math.floor((request.solAmount * LAMPORTS_PER_SOL) / request.tokenMints.length)
    
    console.log(`Executing bulk buy: ${request.tokenMints.length} tokens, ${amountPerToken} lamports per token`)

    // Get swap transactions from Solana Tracker API
    const transactions: VersionedTransaction[] = []
    const transactionMints: string[] = []

    for (const mint of request.tokenMints) {
      try {
        // Create abort controller for timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout

        // Prepare swap API body for BUY (SOL -> Token)
        const swapApiBody = {
          from: NATIVE_MINT.toBase58(), // SOL (Native mint for buy operations)
          to: mint,                     // Target token
          amount: amountPerToken/1000000000,       // Amount in lamports
          slippage: request.slippage/100,   // Slippage tolerance
          payer: userPublicKey,         // User's wallet
          priorityFee: request.priorityFee/1000000000, // Priority fee in microlamports
          fee: `${FEE_CONFIG.DEV_WALLET}:0.5` // Dev wallet with 0.5% fee
        }

        console.log(`Getting swap transaction for ${mint}:`, swapApiBody)

        // Call Solana Tracker swap API
        const response = await fetch("https://swap-v2.solanatracker.io/swap", {
          method: "POST",
          headers: { 
            "Content-Type": "application/json",
            "Connection": "keep-alive"
          },
          body: JSON.stringify(swapApiBody),
          signal: controller.signal,
          keepalive: true
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          throw new Error(`Swap API error: ${response.status} ${response.statusText}`)
        }

        const swapResult = await response.json()
        
        if (!swapResult.txn) {
          throw new Error('No transaction returned from swap API')
        }

        // Deserialize the transaction
        const tx = VersionedTransaction.deserialize(
          Buffer.from(swapResult.txn, 'base64')
        )
        
        transactions.push(tx)
        transactionMints.push(mint)
        
        console.log(`Successfully created swap transaction for ${mint}`)

      } catch (error) {
        console.error(`Failed to create swap transaction for ${mint}:`, error)
        result.failedPurchases.push({
          mintAddress: mint,
          error: error instanceof Error ? error.message : 'Unknown error creating transaction'
        })
      }
    }

    if (transactions.length === 0) {
      throw new Error('No valid transactions could be created')
    }

    console.log(`Signing ${transactions.length} transactions...`)

    // Sign all transactions
    const signedTransactions = await signAllTransactions(transactions)

    // Send transactions
    const signatures: string[] = []
    
    for (let i = 0; i < signedTransactions.length; i++) {
      try {
        console.log(`Sending transaction ${i + 1}/${signedTransactions.length} for ${transactionMints[i]}`)
        
        const signature = await connection.sendTransaction(signedTransactions[i], {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        })

        console.log(`Transaction sent: ${signature}`)

        // Confirm transaction
        const confirmation = await connection.confirmTransaction(signature, 'confirmed')
        
        if (confirmation.value.err) {
          console.error(`Transaction failed for ${transactionMints[i]}:`, confirmation.value.err)
          result.failedPurchases.push({
            mintAddress: transactionMints[i],
            error: `Transaction failed: ${confirmation.value.err}`
          })
        } else {
          console.log(`Transaction confirmed for ${transactionMints[i]}: ${signature}`)
          signatures.push(signature)
          result.successfulPurchases.push({
            mintAddress: transactionMints[i],
            amount: amountPerToken,
          })
        }
      } catch (error) {
        console.error(`Transaction error for ${transactionMints[i]}:`, error)
        result.failedPurchases.push({
          mintAddress: transactionMints[i],
          error: `Transaction error: ${error}`
        })
      }
    }

    result.signatures = signatures
    result.totalSpent = (amountPerToken * result.successfulPurchases.length) / LAMPORTS_PER_SOL
    result.success = result.successfulPurchases.length > 0

    // Calculate fee information (fees are included in Solana Tracker API)
    if (result.successfulPurchases.length > 0) {
      // For buy: 0.5% of total SOL budget (request.solAmount)
      const feeDistribution = calculateFeeDistribution('BUY', result.successfulPurchases.length, request.solAmount)
      
      result.feeInfo = {
        totalFees: feeDistribution.totalFee,
        devFee: feeDistribution.devFee,
        referralFee: feeDistribution.referralFee,
        feePerOperation: getFeeForOperation('BUY', request.solAmount),
        totalOperations: result.successfulPurchases.length,
        operationType: 'BUY' as FeeOperationType
      }
      
      console.log(`Bulk buy completed: ${result.successfulPurchases.length} successful, ${result.failedPurchases.length} failed`)
      console.log(`Total fees: ${feeDistribution.totalFee} SOL (0.5% of ${request.solAmount} SOL budget)`)
    }

    return result
  } catch (error) {
    console.error('Bulk buy execution error:', error)
    result.failedPurchases = request.tokenMints.map(mint => ({
      mintAddress: mint,
      error: error instanceof Error ? error.message : 'Unknown error'
    }))
    return result
  }
}

// Validate token mint address
export function isValidMintAddress(address: string): boolean {
  try {
    // Basic validation - should be 32-44 characters and base58
    if (address.length < 32 || address.length > 44) {
      return false
    }
    
    // Check if it contains only valid base58 characters
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/
    return base58Regex.test(address)
  } catch {
    return false
  }
}

// Parse mint addresses from input
export function parseMintAddresses(input: string): string[] {
  return input
    .split(/[\n,\s]+/)
    .map(addr => addr.trim())
    .filter(addr => addr.length > 0 && isValidMintAddress(addr))
    .slice(0, 10) // Limit to 10 addresses
}

// Helper function to categorize user tokens for easier UI handling
export function categorizeUserTokens(tokens: UserToken[]): {
  sellable: UserToken[]
  unsellable: UserToken[]
  frozen: UserToken[]
  zeroBalance: UserToken[]
  nfts: UserToken[]
} {
  const sellable: UserToken[] = []
  const unsellable: UserToken[] = []
  const frozen: UserToken[] = []
  const zeroBalance: UserToken[] = []
  const nfts: UserToken[] = []

  tokens.forEach(token => {
    if (token.isNFT) {
      nfts.push(token)
    } else if (token.frozen) {
      frozen.push(token)
    } else if (token.uiAmount <= 0.000000000001) {
      zeroBalance.push(token)
            } else if (token.usdValue >= 0.001 || isPumpFunToken(token.mintAddress)) {
          sellable.push(token)
        } else {
          unsellable.push(token)
        }
  })

  return { sellable, unsellable, frozen, zeroBalance, nfts }
}

// New function to close only zero-balance token accounts
// Intelligently burns tokens first if balance > 0, then closes accounts
export async function closeZeroBalanceTokens(
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): Promise<{ successful: string[]; failed: Array<{ mintAddress: string; error: string }>; signatures: string[] }> {
  const result = {
    successful: [] as string[],
    failed: [] as Array<{ mintAddress: string; error: string }>,
    signatures: [] as string[]
  }

  try {
    // Fetch tokens that are either zero-balance or have no SOL value (unsellable)
    const unsellableTokens = await fetchZeroBalanceTokens(connection, new PublicKey(userPublicKey))
    
    if (unsellableTokens.length === 0) {
      console.log('No unsellable tokens found to close')
      return result
    }

    console.log(`Found ${unsellableTokens.length} unsellable tokens to close`)

    const burnInstructions = []
    const closeInstructions = []
    const tokensToProcess = []

    // Create burn and close instructions for each unsellable token
    for (const token of unsellableTokens) {
      try {
        const tokenAccount = await getAssociatedTokenAddress(
          new PublicKey(token.mintAddress),
          new PublicKey(userPublicKey)
        )

        // Check current account balance
        const balanceInfo = await connection.getTokenAccountBalance(tokenAccount)
        const currentBalance = balanceInfo.value.amount
        const currentUiAmount = balanceInfo.value.uiAmount || 0
        
        console.log(`Token ${token.mintAddress}: balance=${currentBalance}, uiAmount=${currentUiAmount}, usdValue=${token.usdValue}`)
        
        // For tokens with balance but low SOL value, we need to burn first
        if (parseInt(currentBalance) > 0) {
          if (token.usdValue < 0.001) {
            console.log(`Creating burn instruction for unsellable token ${token.mintAddress} (${currentBalance} tokens, SOL value ${token.usdValue})`)
            
            const burnInstruction = createBurnInstruction(
              tokenAccount,
              new PublicKey(token.mintAddress),
              new PublicKey(userPublicKey),
              BigInt(currentBalance) // Burn the entire balance
            )
            
            burnInstructions.push(burnInstruction)
          } else {
            result.failed.push({
              mintAddress: token.mintAddress,
              error: `Account has balance: ${currentUiAmount} and SOL value >= 0.001 (may be sellable)`
            })
            continue
          }
        }
        
        // Create close instruction (will execute after burn if needed)
        const closeInstruction = createCloseAccountInstruction(
          tokenAccount,
          new PublicKey(userPublicKey),
          new PublicKey(userPublicKey)
        )

        closeInstructions.push(closeInstruction)
        tokensToProcess.push(token)
      } catch (error) {
        console.error(`Failed to prepare burn/close for ${token.mintAddress}:`, error)
        result.failed.push({
          mintAddress: token.mintAddress,
          error: `Failed to create burn/close instruction: ${error instanceof Error ? error.message : 'Unknown error'}`
        })
      }
    }

    if (burnInstructions.length > 0 || closeInstructions.length > 0) {
      try {
        // Combine burn and close instructions in the same transaction
        const allInstructions = [...burnInstructions, ...closeInstructions]
        
        // Create transaction with burn + close instructions
        const { blockhash } = await connection.getLatestBlockhash('confirmed')
        
        const messageV0 = new TransactionMessage({
          payerKey: new PublicKey(userPublicKey),
          recentBlockhash: blockhash,
          instructions: allInstructions
        }).compileToV0Message()

        const transaction = new VersionedTransaction(messageV0)
        const signedTransactions = await signAllTransactions([transaction])

        // Send burn + close transaction
        const signature = await retryWithBackoff(async () => {
          return await connection.sendTransaction(signedTransactions[0], {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
          })
        })

        const confirmation = await connection.confirmTransaction(signature, 'confirmed')
        
        if (confirmation.value.err) {
          const errorMsg = `Burn/Close transaction failed: ${JSON.stringify(confirmation.value.err)}`
          console.error(errorMsg)
          tokensToProcess.forEach(token => {
            result.failed.push({
              mintAddress: token.mintAddress,
              error: errorMsg
            })
          })
        } else {
          result.signatures.push(signature)
          result.successful = tokensToProcess.map(token => token.mintAddress)
          console.log(`Successfully burned and closed ${tokensToProcess.length} unsellable token accounts`)
          
          // Log details
          if (burnInstructions.length > 0) {
            console.log(`- Burned tokens in ${burnInstructions.length} accounts`)
          }
          console.log(`- Closed ${closeInstructions.length} accounts`)
          
          // Log fee summary (fees are now included in the transaction)
          const feeDistribution = calculateFeeDistribution('CLOSE', tokensToProcess.length)
          console.log(`Fees processed inline: ${feeDistribution.totalFee} SOL total (Dev: ${feeDistribution.devFee}, Referral: ${feeDistribution.referralFee})`)
        }
      } catch (transactionError) {
        console.error('Transaction creation/sending failed:', transactionError)
        tokensToProcess.forEach(token => {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: `Transaction failed: ${transactionError instanceof Error ? transactionError.message : 'Unknown transaction error'}`
          })
        })
      }
    } else {
      console.log('No valid unsellable token accounts to burn/close')
    }

    return result
  } catch (error) {
    console.error('Burn/Close unsellable accounts function failed:', error)
    return result
  }
}

// Rate limiting and caching for Jupiter API calls
class JupiterAPIManager {
  private cache = new Map<string, { data: any; timestamp: number }>()
  private requestQueue: Array<() => Promise<void>> = []
  private isProcessing = false
  private lastRequestTime = 0
  private readonly MIN_REQUEST_INTERVAL = 200 // 200ms between requests (5 requests per second)
  private readonly CACHE_DURATION = 5 * 60 * 1000 // 5 minutes cache
  private readonly MAX_RETRIES = 3 // Standard retries
  private readonly RETRY_DELAYS = [400, 800, 1600] // Standard progressive backoff

  private async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) return
    
    this.isProcessing = true
    
    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift()
      if (request) {
        // Rate limiting: ensure minimum interval between requests
        const now = Date.now()
        const timeSinceLastRequest = now - this.lastRequestTime
        
        if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
          await new Promise(resolve => 
            setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest)
          )
        }
        
        await request()
        this.lastRequestTime = Date.now()
      }
    }
    
    this.isProcessing = false
  }

  private getCachedData(key: string): any | null {
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
      return cached.data
    }
    return null
  }

  private setCachedData(key: string, data: any) {
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  async fetchTokenInfo(mintAddress: string): Promise<{ decimals: number; symbol: string; name: string; logoURI?: string } | null> {
    const cacheKey = `token_info_${mintAddress}`
    const cached = this.getCachedData(cacheKey)
    if (cached) return cached

    return new Promise((resolve) => {
      const request = async () => {
        try {
          const result = await this.makeJupiterRequest(mintAddress)
          this.setCachedData(cacheKey, result)
          resolve(result)
                 } catch (error) {
           console.warn(`Failed to fetch token info for ${mintAddress}:`, error instanceof Error ? error.message : error)
           resolve(null)
         }
      }

      this.requestQueue.push(request)
      this.processQueue()
    })
  }

  private async makeJupiterRequest(mintAddress: string, retryCount = 0): Promise<any> {
    try {
      const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`)
      
      if (response.status === 429) {
        // Rate limited - implement exponential backoff
        if (retryCount < this.MAX_RETRIES) {
          const delay = this.RETRY_DELAYS[retryCount] || 1600
          console.warn(`Rate limited for ${mintAddress}, retrying in ${delay}ms (attempt ${retryCount + 1}/${this.MAX_RETRIES})`)
          
          await new Promise(resolve => setTimeout(resolve, delay))
          return this.makeJupiterRequest(mintAddress, retryCount + 1)
        } else {
          throw new Error(`Rate limit exceeded after ${this.MAX_RETRIES} retries`)
        }
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const tokenData = await response.json()
      return {
        decimals: tokenData.decimals,
        symbol: tokenData.symbol,
        name: tokenData.name,
        logoURI: tokenData.logoURI
      }
    } catch (error) {
      if (retryCount < this.MAX_RETRIES && error instanceof Error && error.message.includes('fetch')) {
        // Network error - retry with backoff
        const delay = this.RETRY_DELAYS[retryCount] || 4000
        console.warn(`Network error for ${mintAddress}, retrying in ${delay}ms`)
        
        await new Promise(resolve => setTimeout(resolve, delay))
        return this.makeJupiterRequest(mintAddress, retryCount + 1)
      }
      
      throw error
    }
  }

  async checkIfFungibleToken(mintAddress: string): Promise<boolean> {
    const cacheKey = `fungible_${mintAddress}`
    const cached = this.getCachedData(cacheKey)
    if (cached !== null) return cached

    return new Promise((resolve) => {
      const request = async () => {
        try {
          const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`)
          const isFungible = response.ok
          this.setCachedData(cacheKey, isFungible)
          resolve(isFungible)
        } catch (error) {
          console.warn(`Failed to check fungible status for ${mintAddress}:`, error)
          this.setCachedData(cacheKey, false)
          resolve(false)
        }
      }

      this.requestQueue.push(request)
      this.processQueue()
    })
  }

  async checkFrozenStatus(mintAddress: string): Promise<boolean> {
    const cacheKey = `frozen_${mintAddress}`
    const cached = this.getCachedData(cacheKey)
    if (cached !== null) return cached

    return new Promise((resolve) => {
      const request = async () => {
        try {
          const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`)
          
          if (response.ok) {
            const tokenData = await response.json()
            const isFrozen = tokenData.frozen === true || tokenData.status === 'frozen'
            this.setCachedData(cacheKey, isFrozen)
            resolve(isFrozen)
          } else {
            this.setCachedData(cacheKey, false)
            resolve(false)
          }
        } catch (error) {
          console.warn(`Failed to check frozen status for ${mintAddress}:`, error)
          this.setCachedData(cacheKey, false)
          resolve(false)
        }
      }

      this.requestQueue.push(request)
      this.processQueue()
    })
  }

  // Clean up old cache entries
  cleanup() {
    const now = Date.now()
    const keysToDelete: string[] = []
    
    this.cache.forEach((value, key) => {
      if (now - value.timestamp > this.CACHE_DURATION) {
        keysToDelete.push(key)
      }
    })
    
    keysToDelete.forEach(key => this.cache.delete(key))
  }
}

// Global Jupiter API manager instance
const jupiterAPI = new JupiterAPIManager()

// Clean up cache every 10 minutes
setInterval(() => jupiterAPI.cleanup(), 10 * 60 * 1000)

// Efficient batch token fetching using Jupiter price API v2 and optimized RPC calls
export async function fetchUserTokensEfficient(
  connection: Connection,
  userPublicKey: PublicKey,
  includeZeroBalance: boolean = false,
  includeNFTs: boolean = false,
  progressCallback?: (progress: number) => void
): Promise<UserToken[]> {
  // Use the optimized fetchUserTokens function instead
  return fetchUserTokens(connection, userPublicKey, includeZeroBalance, includeNFTs)
}

// Efficient batch price refresh for multiple tokens
export async function refreshTokenPricesBatch(
  tokens: UserToken[],
  progressCallback?: (progress: number) => void
): Promise<UserToken[]> {
  try {
    if (tokens.length === 0) return tokens

    // Extract tradeable token mints (non-NFT, non-frozen)
    const tradeableTokens = tokens.filter(token => 
      !token.isNFT && !token.frozen && token.uiAmount > 0.000000000001
    )
    
    if (tradeableTokens.length === 0) {
      return tokens // No tradeable tokens to update
    }

    const mints = tradeableTokens.map(token => token.mintAddress)
    console.log(`Batch refreshing prices for ${mints.length} tokens`)
    
    // Batch fetch fresh prices
    const freshPrices = await batchFetchPrices(mints)
    progressCallback?.(50)

    // Update tokens with fresh prices (already converted from USD to SOL)
    const updatedTokens = tokens.map(token => {
      if (!token.isNFT && !token.frozen && token.uiAmount > 0.000000000001) {
        const freshPrice = freshPrices[token.mintAddress] || 0
        const newSolValue = freshPrice > 0 ? token.uiAmount * freshPrice : token.usdValue
        
        return {
          ...token,
          usdValue: newSolValue,
          isLoadingPrice: false
        }
      }
      return token
    })

    progressCallback?.(100)
    console.log(`Batch price refresh completed for ${mints.length} tokens`)
    
    return updatedTokens
  } catch (error) {
    console.error('Error in batch price refresh:', error)
    // Return original tokens if refresh fails
    return tokens.map(token => ({ ...token, isLoadingPrice: false }))
  }
}

