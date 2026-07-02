import { Connection, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createCloseAccountInstruction, createBurnInstruction, NATIVE_MINT } from '@solana/spl-token'

/** Token-2022 program (used for ATA fallback when mint-scoped RPC lookup returns nothing). */
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults"
import { publicKey } from "@metaplex-foundation/umi"
import { fetchAllDigitalAssetWithTokenByOwner } from "@metaplex-foundation/mpl-token-metadata"
import { TOKENS } from './solana'
import jupiterApiUtils from './jupiter-api'
import {
  waitForRaptorConfirmation,
} from './solanatracker-raptor'
import {
  prepareBulkSwapTransaction,
  submitSignedSwap,
  fetchSwapQuote,
  buildSwapTransaction,
  signTransactionsWithFallback,
  type PreparedSwapMeta,
} from './swap-executor'
import {
  craftReclaimTransaction,
  extractReclaimTransactionBase64,
  injectInstructionsIntoVersionedTransaction,
} from './jupiter-reclaim'
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

  try {
    // Use the new Jupiter API manager for better caching and rate limiting
    const priceData = await jupiterApiUtils.fetchTokenPrices(mints, {
      timeout: 10000,
      retries: 0 // We handle retries at the manager level
    })

    const prices: Record<string, number> = {}

    Object.entries(priceData).forEach(([mint, data]) => {
      prices[mint] = data.price
      // Cache the USD price
      priceCache.set(mint, {
        price: data.price,
        timestamp: Date.now()
      })
    })

    stopTimer('jupiter-batch')
    console.log(`Fetched USD prices for ${Object.keys(prices).length}/${mints.length} tokens`)
    return prices
  } catch (error) {
    console.error('Batch price fetch failed:', error)

    // Fallback: set all mints to 0 price
    const prices: Record<string, number> = {}
    mints.forEach(mint => {
      prices[mint] = 0
    })

    stopTimer('jupiter-batch')
    return prices
  }
}

// Get cached price or fetch if expired - Returns price in USD
async function getCachedPrice(mint: string): Promise<number> {
  const cached = priceCache.get(mint)
  if (cached && (Date.now() - cached.timestamp) < PRICE_CACHE_DURATION) {
    return cached.price
  }

  // Use Jupiter API manager for better rate limiting
  try {
    const priceData = await jupiterApiUtils.fetchTokenPrices([mint])
    const price = priceData[mint]?.price || 0

    // Cache the price
    priceCache.set(mint, {
      price: price,
      timestamp: Date.now()
    })

    return price
  } catch (error) {
    console.warn('Jupiter API manager failed, falling back to direct fetch:', error)
    // Fallback to original method
    const prices = await batchFetchPrices([mint])
    return prices[mint] || 0
  }
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

// Helper function to get a human-readable token identifier for logging
function getTokenIdentifierForLogging(mintAddress: string): string {
  // Check common tokens first
  const tokenSymbols: Record<string, string> = {
    [TOKENS.SOL]: 'SOL',
    [TOKENS.USDC]: 'USDC',
    [TOKENS.USDT]: 'USDT',
  }

  if (tokenSymbols[mintAddress]) {
    return tokenSymbols[mintAddress]
  }

  // Check token cache for previously fetched metadata
  const cached = tokenCache.get(mintAddress)
  if (cached?.data?.symbol && cached.data.symbol !== 'Unknown') {
    return `${cached.data.symbol} (${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)})`
  }

  // Fallback to truncated address
  return `${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)}`
}

// Get quote for a single token swap (Raptor quote — no lite-api)
export async function getSwapQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number = 100
): Promise<SwapQuote | null> {
  return fetchSwapQuote(inputMint, outputMint, amount, slippageBps)
}

// Get swap transaction — Raptor quote-and-swap
export async function getSwapTransaction(
  quote: SwapQuote,
  userPublicKey: string,
  priorityFeeLamports: number = 0,
  _additionalInstructions: any[] = []
): Promise<SwapTransaction | null> {
  return buildSwapTransaction(quote, userPublicKey, priorityFeeLamports, {
    feeAccount: FEE_CONFIG.DEV_WALLET,
    feeBps: 50,
  })
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
  'CfP4fzhbkCW86YtTofzMQFBPxg5YyW9LZt1KgBcMEtAL', // CRAZY FORG RUG
]

const PROBLEMATIC_MINTS = [
  '1Qf8gESP4i6CFNWerUSDdLKJ9U1LpqTYvjJ2MM4pain', // PAIN
  'SNS8DJbHc34nKySHVhLGMUUE72ho6igvJaxtq9TYvjJ2MM4pain', // SNS
]

// Add dynamic problematic tokens tracking
const dynamicProblematicMints = new Set<string>()
const ALL_EXCLUDED_MINTS = [...EXCLUDED_MINTS, ...PROBLEMATIC_MINTS]

// Add loading state to prevent duplicate fetches
let tokenFetchPromise: Promise<UserToken[]> | null = null

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

  // Use the new batch API for much faster metadata fetching
  // try {
  //   const mints = tokensNeedingMetadata.map(token => token.mintAddress)
  //   const batchMetadata = await jupiterAPI.fetchTokenInfoBatch(mints)
  //
  //   const enrichedTokens: UserToken[] = []
  //
  //   tokensNeedingMetadata.forEach(token => {
  //     try {
  //       const metadata = batchMetadata[token.mintAddress]
  //       if (metadata) {
  //         // Update the token object directly (this will reflect in the UI if tokens are reactive)
  //         token.symbol = metadata.symbol
  //         token.name = metadata.name
  //         token.logoURI = metadata.logoURI
  //
  //         // Update cache with enriched metadata
  //         const cached = tokenCache.get(token.mintAddress)
  //         if (cached) {
  //           cached.data = { ...cached.data, ...metadata }
  //           tokenCache.set(token.mintAddress, cached)
  //         }
  //
  //         console.log(`Enriched metadata for ${metadata.symbol} (${token.mintAddress})`)
  //         enrichedTokens.push(token)
  //       }
  //     } catch (error) {
  //       console.warn(`Failed to process metadata for ${token.mintAddress}:`, error)
  //     } finally {
  //       // Remove from processing set
  //       metadataEnrichmentInProgress.delete(token.mintAddress)
  //     }
  //   })
  //
  //   // Trigger UI update callback if any tokens were enriched
  //   if (enrichedTokens.length > 0 && metadataUpdateCallback) {
  //     metadataUpdateCallback(enrichedTokens)
  //   }
  // } catch (error) {
  //   console.error('Batch metadata enrichment failed:', error)

  // Fallback to individual requests if batch fails
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

    // Use decimals from token account if mint data is missing
    const decimals = data?.decimals ?? account.account.data.parsed.info.tokenAmount.decimals

    // Check if it's likely an NFT (supply = 1, decimals = 0)
    // If we don't have mint data, assume it's not an NFT unless we verify otherwise later
    const isNFT = data ? (data.decimals === 0 && data.supply <= 1) : false

    // Calculate USD value properly: price * token amount
    const price = prices[mint] || 0
    const usdValue = price > 0 ? tokenAmount * price : 0

    const userToken: UserToken = {
      mintAddress: mint,
      balance: balance,
      decimals: decimals,
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

const RPC_FETCH_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms / 1000}s. Try another RPC endpoint.`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// Main efficient token fetching function based on reference
export async function fetchUserTokens(
  connection: Connection,
  userPublicKey: PublicKey,
  includeZeroBalance: boolean = false,
  includeNFTs: boolean = false,
  forceRefresh: boolean = false,
): Promise<UserToken[]> {
  if (forceRefresh) {
    tokenFetchPromise = null
    clearAllCaches()
  }

  // If a fetch is already in progress, return the existing promise
  if (tokenFetchPromise) {
    console.log('Token fetch already in progress, joining existing request...')
    try {
      const results = await tokenFetchPromise
      // We need to re-filter the results based on the current request parameters
      // because the in-flight request might have different flags
      const filteredResults = results.filter(token => {
        // Filter zero balance if needed
        if (!includeZeroBalance && token.uiAmount <= 0) return false
        // Filter NFTs if needed
        if (!includeNFTs && token.isNFT) return false
        return true
      })
      return filteredResults
    } catch (error) {
      console.error('Error in joined token fetch:', error)
      // If the shared promise failed, we'll try a new fetch below
    }
  }

  // Create a new fetch promise
  tokenFetchPromise = (async () => {
    try {
      startTimer('total-token-fetch')

      // Single RPC call to get all token accounts
      const tokenAccounts = await withTimeout(
        connection.getParsedTokenAccountsByOwner(userPublicKey, {
          programId: TOKEN_PROGRAM_ID,
        }),
        RPC_FETCH_TIMEOUT_MS,
        'Token account fetch',
      )

      // Get all accounts initially (we'll filter later)
      const relevantAccounts = tokenAccounts.value

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

      // Asynchronously enrich token metadata (non-blocking)
      enrichTokenMetadataAsync(processedTokens)

      stopTimer('total-token-fetch')
      console.log(`Processed ${processedTokens.length} tokens efficiently`)

      return processedTokens.sort((a, b) => {
        const aIsSellable = isSwappableToken(a)
        const bIsSellable = isSwappableToken(b)

        if (aIsSellable && !bIsSellable) return -1
        if (!aIsSellable && bIsSellable) return 1
        if (aIsSellable && bIsSellable) {
          const aValuable = a.usdValue >= DUST_USD_THRESHOLD
          const bValuable = b.usdValue >= DUST_USD_THRESHOLD
          if (aValuable && !bValuable) return -1
          if (!aValuable && bValuable) return 1
          return b.usdValue - a.usdValue
        }

        return (a.symbol || '').localeCompare(b.symbol || '')
      })
    } finally {
      tokenFetchPromise = null
    }
  })()

  try {
    const allTokens = await tokenFetchPromise

    // Apply filters for this specific request
    return allTokens.filter(token => {
      // Filter zero balance if needed
      if (!includeZeroBalance && token.uiAmount <= 0) return false
      // Filter NFTs if needed
      if (!includeNFTs && token.isNFT) return false
      return true
    })
  } catch (error) {
    console.error('Error fetching user tokens:', error)
    throw error instanceof Error ? error : new Error(String(error))
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
    // Include empty accounts or zero-value tokens (no market price), excluding frozen tokens
    return allTokens.filter(
      (token) =>
        !token.frozen &&
        (token.uiAmount <= MIN_BALANCE_UI || isZeroValueToken(token)),
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
    // const jupiterResult = await jupiterAPI.fetchTokenInfo(mintAddress)
    // if (jupiterResult) {
    //   return jupiterResult
    // }

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

function isRpcAccountNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('could not find account') ||
    message.includes('Account does not exist') ||
    message.includes('Invalid param')
  )
}

type CloseAccountsResult = {
  successful: string[]
  failed: Array<{ mintAddress: string; error: string }>
  signatures: string[]
}

function buildCloseFeeInstructions(
  userPublicKey: string,
  closableCount: number,
  sellData?: { successfulSwapsCount: number; totalSolReceived: number }
) {
  const owner = new PublicKey(userPublicKey)
  const closeFeeInstructions = createFeeTransferInstructions(owner, 'CLOSE', closableCount)
  const sellFeeInstructions = sellData
    ? createFeeTransferInstructions(
        owner,
        'SELL',
        sellData.successfulSwapsCount,
        sellData.totalSolReceived
      )
    : []
  return [...closeFeeInstructions, ...sellFeeInstructions]
}

type ManualCloseTokenAccount = {
  account: PublicKey
  mint: PublicKey
  programId: PublicKey
  balance: bigint
}

/**
 * Resolve on-chain token accounts to close (Solana close-account flow).
 * Uses mint-scoped parsed lookup first, then SPL / Token-2022 ATA fallbacks.
 */
async function resolveTokenAccountsForManualClose(
  connection: Connection,
  owner: PublicKey,
  mintAddresses: string[],
): Promise<ManualCloseTokenAccount[]> {
  const resolved: ManualCloseTokenAccount[] = []

  for (const mintAddress of mintAddresses) {
    const mint = new PublicKey(mintAddress)

    const parsed = await connection.getParsedTokenAccountsByOwner(owner, { mint })
    if (parsed.value.length > 0) {
      for (const entry of parsed.value) {
        const info = entry.account.data.parsed.info as {
          mint: string
          tokenAmount: { amount: string }
        }
        resolved.push({
          account: entry.pubkey,
          mint: new PublicKey(info.mint),
          programId: entry.account.owner,
          balance: BigInt(info.tokenAmount.amount),
        })
      }
      continue
    }

    const ataCandidates: Array<{ programId: PublicKey; account: PublicKey }> = [
      {
        programId: TOKEN_PROGRAM_ID,
        account: await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID),
      },
      {
        programId: TOKEN_2022_PROGRAM_ID,
        account: await getAssociatedTokenAddress(mint, owner, false, TOKEN_2022_PROGRAM_ID),
      },
    ]

    let found = false
    for (const candidate of ataCandidates) {
      const accountInfo = await connection.getAccountInfo(candidate.account)
      if (!accountInfo) {
        continue
      }

      try {
        const balanceInfo = await connection.getTokenAccountBalance(candidate.account)
        resolved.push({
          account: candidate.account,
          mint,
          programId: candidate.programId,
          balance: BigInt(balanceInfo.value.amount),
        })
        found = true
        break
      } catch (balanceError) {
        if (isRpcAccountNotFoundError(balanceError)) {
          continue
        }
        throw balanceError
      }
    }

    if (!found) {
      console.log(`No on-chain token account found for manual close: ${mintAddress}`)
    }
  }

  return resolved
}

function buildManualCloseInstructions(
  accounts: ManualCloseTokenAccount[],
  owner: PublicKey,
): TransactionInstruction[] {
  const instructions = []

  for (const tokenAccount of accounts) {
    // Solana docs: balance must be zero before close — burn remaining tokens first.
    if (tokenAccount.balance > BigInt(0)) {
      instructions.push(
        createBurnInstruction(
          tokenAccount.account,
          tokenAccount.mint,
          owner,
          tokenAccount.balance,
          [],
          tokenAccount.programId,
        ),
      )
    }

    // CloseAccount: reclaim rent to destination (wallet owner).
    instructions.push(
      createCloseAccountInstruction(
        tokenAccount.account,
        owner,
        owner,
        [],
        tokenAccount.programId,
      ),
    )
  }

  return instructions
}

async function sendSignedCloseTransaction(
  transaction: VersionedTransaction,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): Promise<string> {
  const signedTransactions = await signAllTransactions([transaction])
  const signature = await retryWithBackoff(async () => {
    return await connection.sendTransaction(signedTransactions[0], {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    })
  })

  const confirmation = await connection.confirmTransaction(signature, 'confirmed')
  if (confirmation.value.err) {
    throw new Error(`Burn/Close transaction failed: ${JSON.stringify(confirmation.value.err)}`)
  }

  return signature
}

async function executeManualCloseTransaction(
  closableTokens: UserToken[],
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>,
  sellData?: { successfulSwapsCount: number; totalSolReceived: number }
): Promise<string> {
  const owner = new PublicKey(userPublicKey)
  const mintAddresses = closableTokens.map((token) => token.mintAddress)
  const tokenAccounts = await resolveTokenAccountsForManualClose(connection, owner, mintAddresses)

  if (tokenAccounts.length === 0) {
    throw new Error('No closable token accounts remain for manual close')
  }

  const closeInstructions = buildManualCloseInstructions(tokenAccounts, owner)
  const feeInstructions = buildCloseFeeInstructions(
    userPublicKey,
    tokenAccounts.length,
    sellData,
  )

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const messageV0 = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [...closeInstructions, ...feeInstructions],
  }).compileToV0Message()

  return sendSignedCloseTransaction(
    new VersionedTransaction(messageV0),
    connection,
    signAllTransactions,
  )
}

async function tryJupiterReclaimClose(
  closableTokens: UserToken[],
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>,
  sellData?: { successfulSwapsCount: number; totalSolReceived: number }
): Promise<string> {
  const mints = closableTokens.map((token) => token.mintAddress)
  const craftResponse = await craftReclaimTransaction(userPublicKey, mints)
  const transactionBase64 = extractReclaimTransactionBase64(craftResponse)

  if (!transactionBase64) {
    throw new Error('Jupiter reclaim craft returned no transaction')
  }

  const feeInstructions = buildCloseFeeInstructions(
    userPublicKey,
    closableTokens.length,
    sellData
  )

  const transaction = await injectInstructionsIntoVersionedTransaction(
    connection,
    transactionBase64,
    feeInstructions,
    new PublicKey(userPublicKey)
  )

  return sendSignedCloseTransaction(transaction, connection, signAllTransactions)
}

function filterClosableTokens(
  tokens: UserToken[],
): {
  closableTokens: UserToken[]
  failed: Array<{ mintAddress: string; error: string }>
} {
  const closableTokens: UserToken[] = []
  const failed: Array<{ mintAddress: string; error: string }> = []

  for (const token of tokens) {
    if (token.frozen) {
      failed.push({
        mintAddress: token.mintAddress,
        error: 'Token account is frozen and cannot be closed'
      })
      continue
    }

    closableTokens.push(token)
  }

  return { closableTokens, failed }
}

async function executeCloseForTokens(
  closableTokens: UserToken[],
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>,
  sellData?: { successfulSwapsCount: number; totalSolReceived: number }
): Promise<{ signature: string; method: 'jupiter-reclaim' | 'manual' }> {
  if (closableTokens.length === 0) {
    throw new Error('No closable token accounts to process')
  }

  try {
    const signature = await tryJupiterReclaimClose(
      closableTokens,
      userPublicKey,
      connection,
      signAllTransactions,
      sellData
    )
    console.log(`Successfully reclaimed ${closableTokens.length} token accounts via Jupiter`)
    return { signature, method: 'jupiter-reclaim' }
  } catch (reclaimError) {
    console.warn(
      'Jupiter reclaim close failed, falling back to manual burn+close:',
      reclaimError instanceof Error ? reclaimError.message : reclaimError
    )
  }

  const signature = await executeManualCloseTransaction(
    closableTokens,
    userPublicKey,
    connection,
    signAllTransactions,
    sellData
  )
  console.log(`Successfully burned and closed ${closableTokens.length} token accounts via manual path`)
  return { signature, method: 'manual' }
}

// Close token accounts after successful sales with improved error handling
// Primary path: Jupiter /reclaim/craft; fallback: manual burn + close
async function closeTokenAccounts(
  tokens: UserToken[],
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>,
  sellData?: { successfulSwapsCount: number; totalSolReceived: number }
): Promise<CloseAccountsResult> {
  const result: CloseAccountsResult = {
    successful: [],
    failed: [],
    signatures: []
  }

  try {
    const { closableTokens, failed } = filterClosableTokens(tokens)

    result.failed.push(...failed)

    if (closableTokens.length === 0) {
      console.log('No token accounts to burn/close')
      return result
    }

    try {
      const { signature } = await executeCloseForTokens(
        closableTokens,
        userPublicKey,
        connection,
        signAllTransactions,
        sellData
      )
      result.signatures.push(signature)
      result.successful = closableTokens.map((token) => token.mintAddress)
    } catch (transactionError) {
      console.error('Close transaction failed:', transactionError)
      const errorMessage = transactionError instanceof Error
        ? transactionError.message
        : 'Unknown transaction error'
      closableTokens.forEach((token) => {
        result.failed.push({
          mintAddress: token.mintAddress,
          error: `Transaction failed: ${errorMessage}`
        })
      })
    }

    return result
  } catch (error) {
    console.error('Burn/Close accounts function failed:', error)
    tokens.forEach((token) => {
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
    // Track start time for performance measurement
    const start = Date.now()

    // Calculate amount per token based on input currency
    const inputCurrencyDecimals = request.inputCurrency === 'USDC' ? 6 : 9 // USDC has 6 decimals, SOL has 9
    const inputCurrencyMultiplier = Math.pow(10, inputCurrencyDecimals)
    const amountPerToken = Math.floor((request.solAmount * inputCurrencyMultiplier) / request.tokenMints.length)

    console.log(`🔍 Input currency: ${request.inputCurrency}, decimals: ${inputCurrencyDecimals}, multiplier: ${inputCurrencyMultiplier}`)
    console.log(`💰 Amount per token: ${amountPerToken} (in ${request.inputCurrency} smallest units)`)

    console.log(`Executing bulk buy: ${request.tokenMints.length} tokens, ${amountPerToken} ${request.inputCurrency} units per token`)

    let blockhashInfo: { blockhash: string; lastValidBlockHeight: number } | null = null;
    const getBlockhash = async () => {
      if (!blockhashInfo) {
        blockhashInfo = await connection.getLatestBlockhash('confirmed');
      }
      return blockhashInfo;
    };

    // Batch transaction creation (similar to Swap function)
    const transactions: VersionedTransaction[] = []
    const transactionMints: string[] = []
    const transactionMetas: PreparedSwapMeta[] = []
    const BATCH_SIZE = 10 // Process 10 tokens per batch for API calls
    const batches: string[][] = []

    // Create batches
    for (let i = 0; i < request.tokenMints.length; i += BATCH_SIZE) {
      batches.push(request.tokenMints.slice(i, i + BATCH_SIZE))
    }

    // Process batches in parallel
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 45000) // 45 second total timeout

    try {
      await Promise.all(batches.map(async (batch, batchIndex) => {
        const batchStart = batchIndex * BATCH_SIZE
        console.log(`Processing batch ${batchStart}-${batchStart + batch.length} of ${request.tokenMints.length} tokens`)

        // Process tokens in this batch in parallel
        const batchPromises = batch.map(async (mint) => {
          try {
            const inputMint = request.inputCurrency === 'USDC' ? TOKENS.USDC : NATIVE_MINT.toBase58()
            const inputDecimals = request.inputCurrency === 'USDC' ? 6 : 9
            const divisor = Math.pow(10, inputDecimals)

            console.log(`🔍 Raptor swap for ${mint}:`, {
              inputMint,
              outputMint: mint,
              amount: amountPerToken,
              inputCurrency: request.inputCurrency,
            })

            const { tx, meta } = await prepareBulkSwapTransaction({
              userPublicKey,
              inputMint,
              outputMint: mint,
              amount: amountPerToken,
              slippageBps: request.slippage,
              priorityFeeLamports: request.priorityFee,
              feeAccount: FEE_CONFIG.DEV_WALLET,
              feeBps: 50,
              connection,
            })

            console.log(`✅ Swap prepared for ${mint} via ${meta.provider}`)
            return { success: true as const, mint, tx, meta }
          } catch (error) {
            console.error(`Failed to prepare buy for ${mint}:`, error)
            return {
              success: false as const,
              mint,
              error: error instanceof Error ? error.message : 'Unknown error creating transaction',
            }
          }
        })

        // Wait for all transactions in this batch
        const results = await Promise.all(batchPromises)

        // Collect successful transactions and failed ones
        results.forEach(batchResult => {
          if (batchResult.success && batchResult.tx && batchResult.meta) {
            transactions.push(batchResult.tx)
            transactionMints.push(batchResult.mint)
            transactionMetas.push(batchResult.meta)
            console.log(`Transaction prepared for ${batchResult.mint} via ${batchResult.meta.provider}`)
          } else if (!batchResult.success) {
            result.failedPurchases.push({
              mintAddress: batchResult.mint,
              error: batchResult.error,
            })
          }
        })

        console.log(`Batch ${batchStart}-${batchStart + batch.length} completed: ${results.filter(r => r.success).length} successful`)
      }))
    } finally {
      clearTimeout(timeoutId)
    }

    if (transactions.length === 0) {
      throw new Error('No valid transactions could be created')
    }

    console.log(`Signing ${transactions.length} transactions...`)

    const signedTransactions = await signTransactionsWithFallback(
      transactions,
      signAllTransactions,
      async (tx) => {
        const [signed] = await signAllTransactions([tx])
        return signed
      },
    )

    // Send and confirm transactions using batched approach (like sendTransactions)
    const SEND_BATCH_SIZE = 6 // Send 6 transactions at a time
    const signatures: string[] = []

    for (let i = 0; i < signedTransactions.length; i += SEND_BATCH_SIZE) {
      const batch = signedTransactions.slice(i, i + SEND_BATCH_SIZE)
      const batchMints = transactionMints.slice(i, i + SEND_BATCH_SIZE)

      // Send batch transactions in parallel
      const sendPromises = batch.map(async (tx, idx) => {
        const globalIdx = i + idx
        const meta = transactionMetas[globalIdx]

        try {
          const sendResult = await submitSignedSwap({
            signedTx: tx,
            prepared: meta,
            connection,
          })
          return {
            success: true,
            signature: sendResult.signature,
            mintIdx: globalIdx,
            via: sendResult.via,
          }
        } catch (error) {
          console.error(`Failed to send transaction for token ${batchMints[idx]}:`, error)
          return { success: false, mintIdx: globalIdx, error }
        }
      })

      const sendResults = await Promise.all(sendPromises)

      // Process confirmations for successful sends in parallel
      const confirmPromises = sendResults.map(async (sendResult) => {
        if (!sendResult.success) {
          result.failedPurchases.push({
            mintAddress: transactionMints[sendResult.mintIdx],
            error: sendResult.error instanceof Error ? sendResult.error.message : 'Failed to send transaction'
          })
          return
        }

        try {
          if (sendResult.via === 'raptor') {
            await waitForRaptorConfirmation(sendResult.signature!, {
              maxAttempts: 30,
              intervalMs: 2000,
            })

            signatures.push(sendResult.signature!)
            result.successfulPurchases.push({
              mintAddress: transactionMints[sendResult.mintIdx],
              amount: amountPerToken,
            })
            console.log(`✅ Successfully bought ${transactionMints[sendResult.mintIdx]} via Raptor`)
            return
          }

          const { blockhash, lastValidBlockHeight } = await getBlockhash();

          const confirmation = await connection.confirmTransaction({
            signature: sendResult.signature!,
            lastValidBlockHeight,
            blockhash
          }, 'confirmed')

          if (confirmation.value.err) {
            console.error(`Transaction failed: ${sendResult.signature}`, confirmation.value.err)
            result.failedPurchases.push({
              mintAddress: transactionMints[sendResult.mintIdx],
              error: `Transaction failed: ${confirmation.value.err}`
            })
          } else {
            // Verify transaction success on chain
            const txInfo = await connection.getTransaction(sendResult.signature!, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0
            })

            if (txInfo?.meta?.err) {
              result.failedPurchases.push({
                mintAddress: transactionMints[sendResult.mintIdx],
                error: 'Transaction failed on chain'
              })
            } else {
              signatures.push(sendResult.signature!)
              result.successfulPurchases.push({
                mintAddress: transactionMints[sendResult.mintIdx],
                amount: amountPerToken,
              })
              console.log(`✅ Successfully bought ${transactionMints[sendResult.mintIdx]}`)
            }
          }
        } catch (error: any) {
          console.error(`Confirmation failed for ${sendResult.signature}:`, error)
          result.failedPurchases.push({
            mintAddress: transactionMints[sendResult.mintIdx],
            error: error.message && error.message.includes('TransactionExpiredBlockheightExceededError')
              ? 'Transaction expired'
              : `Confirmation failed: ${error.message || 'Unknown error'}`
          })
        }
      })

      await Promise.all(confirmPromises)
      console.log(`Processed batch ${i / SEND_BATCH_SIZE + 1}/${Math.ceil(signedTransactions.length / SEND_BATCH_SIZE)}`)
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

      console.log(`🎉 Bulk buy completed: ${result.successfulPurchases.length} successful, ${result.failedPurchases.length} failed`)
      console.log(`⚡ Total processing time: ${Date.now() - start}ms`)
      console.log(`💰 Total fees: ${feeDistribution.totalFee} SOL (0.5% of ${request.solAmount} SOL budget)`)
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

// Token categorization thresholds (USD position value)
export const DUST_USD_THRESHOLD = 1
export const ZERO_VALUE_USD_THRESHOLD = 0.001
export const MIN_BALANCE_UI = 0.000000000001

export function isSwappableToken(token: UserToken): boolean {
  return (
    !token.frozen &&
    !token.isNFT &&
    token.uiAmount > MIN_BALANCE_UI &&
    (token.usdValue >= ZERO_VALUE_USD_THRESHOLD ||
      isPumpFunToken(token.mintAddress))
  )
}

export function isZeroValueToken(token: UserToken): boolean {
  return (
    !token.frozen &&
    !token.isNFT &&
    token.uiAmount > MIN_BALANCE_UI &&
    token.usdValue < ZERO_VALUE_USD_THRESHOLD &&
    !isPumpFunToken(token.mintAddress)
  )
}

export function isDustToken(token: UserToken): boolean {
  return (
    !token.frozen &&
    !token.isNFT &&
    token.uiAmount > MIN_BALANCE_UI &&
    token.usdValue < DUST_USD_THRESHOLD
  )
}

// Helper function to categorize user tokens for easier UI handling
export function categorizeUserTokens(tokens: UserToken[]): {
  valuable: UserToken[]
  dust: UserToken[]
  zeroValue: UserToken[]
  sellable: UserToken[]
  frozen: UserToken[]
  zeroBalance: UserToken[]
  nfts: UserToken[]
} {
  const valuable: UserToken[] = []
  const dust: UserToken[] = []
  const zeroValue: UserToken[] = []
  const frozen: UserToken[] = []
  const zeroBalance: UserToken[] = []
  const nfts: UserToken[] = []

  tokens.forEach((token) => {
    if (token.isNFT) {
      nfts.push(token)
    } else if (token.frozen) {
      frozen.push(token)
    } else if (token.uiAmount <= MIN_BALANCE_UI) {
      zeroBalance.push(token)
    } else if (isZeroValueToken(token)) {
      zeroValue.push(token)
    } else if (isSwappableToken(token)) {
      if (token.usdValue >= DUST_USD_THRESHOLD) {
        valuable.push(token)
      } else {
        dust.push(token)
      }
    }
  })

  const sellable = [...valuable, ...dust]

  return { valuable, dust, zeroValue, sellable, frozen, zeroBalance, nfts }
}

// New function to close only zero-balance token accounts
// Primary path: Jupiter /reclaim/craft; fallback: manual burn + close
export async function closeZeroBalanceTokens(
  userPublicKey: string,
  connection: Connection,
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): Promise<CloseAccountsResult> {
  const result: CloseAccountsResult = {
    successful: [],
    failed: [],
    signatures: []
  }

  try {
    const unsellableTokens = await fetchZeroBalanceTokens(connection, new PublicKey(userPublicKey))

    if (unsellableTokens.length === 0) {
      console.log('No unsellable tokens found to close')
      return result
    }

    console.log(`Found ${unsellableTokens.length} unsellable tokens to close`)

    const closableTokens: UserToken[] = []

    for (const token of unsellableTokens) {
      try {
        if (token.frozen) {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: 'Token account is frozen and cannot be closed'
          })
          continue
        }

        if (token.usdValue >= 0.001 && token.uiAmount > MIN_BALANCE_UI) {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: `Account has balance and SOL value >= 0.001 (may be sellable)`
          })
          continue
        }

        closableTokens.push(token)
      } catch (error) {
        console.error(`Failed to prepare burn/close for ${token.mintAddress}:`, error)
        result.failed.push({
          mintAddress: token.mintAddress,
          error: `Failed to create burn/close instruction: ${error instanceof Error ? error.message : 'Unknown error'}`
        })
      }
    }

    if (closableTokens.length === 0) {
      console.log('No valid unsellable token accounts to burn/close')
      return result
    }

    try {
      const { signature } = await executeCloseForTokens(
        closableTokens,
        userPublicKey,
        connection,
        signAllTransactions
      )
      result.signatures.push(signature)
      result.successful.push(...closableTokens.map((token) => token.mintAddress))

      const feeDistribution = calculateFeeDistribution('CLOSE', closableTokens.length)
      console.log(`Fees processed inline: ${feeDistribution.totalFee} SOL total (Dev: ${feeDistribution.devFee}, Referral: ${feeDistribution.referralFee})`)
    } catch (transactionError) {
      console.error('Transaction creation/sending failed:', transactionError)
      const errorMessage = transactionError instanceof Error
        ? transactionError.message
        : 'Unknown transaction error'
      closableTokens.forEach((token) => {
        result.failed.push({
          mintAddress: token.mintAddress,
          error: `Transaction failed: ${errorMessage}`
        })
      })
    }

    return result
  } catch (error) {
    console.error('Burn/Close unsellable accounts function failed:', error)
    return result
  }
}

// Server-side Jupiter API Manager - uses our own API endpoint for better caching
class JupiterAPIManager {
  private cache = new Map<string, { data: any; timestamp: number }>()
  private readonly CACHE_DURATION = 5 * 60 * 1000 // 5 minutes client cache (server has 24h cache)
  private readonly MAX_RETRIES = 3
  private readonly RETRY_DELAYS = [400, 800, 1600]

  // Get base URL for API calls - handles both client and server environments
  private getBaseUrl(): string {
    // Client-side: use relative URLs (browser will resolve against current domain)
    if (typeof window !== 'undefined') {
      return ''
    }

    // Server-side: need absolute URL
    return process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || 'http://localhost:3000'
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

    try {
      const result = await this.makeServerRequest(mintAddress)
      if (result) {
        this.setCachedData(cacheKey, result)
      }
      return result
    } catch (error) {
      console.warn(`Failed to fetch token info for ${mintAddress}:`, error instanceof Error ? error.message : error)
      return null
    }
  }

  private async makeServerRequest(mintAddress: string, retryCount = 0): Promise<any> {
    try {
      const baseUrl = this.getBaseUrl()
      const response = await fetch(`${baseUrl}/api/jupiter/metadata?mint=${encodeURIComponent(mintAddress)}`)

      if (!response.ok) {
        throw new Error(`Server API error: ${response.status} ${response.statusText}`)
      }

      const result = await response.json()

      if (result.error) {
        console.warn(`Server returned error for ${mintAddress}:`, result.error)
        return result.data || null
      }

      return result.data
    } catch (error) {
      if (retryCount < this.MAX_RETRIES && error instanceof Error && error.message.includes('fetch')) {
        // Network error - retry with backoff
        const delay = this.RETRY_DELAYS[retryCount] || 1600
        console.warn(`Network error for ${mintAddress}, retrying in ${delay}ms`)

        await new Promise(resolve => setTimeout(resolve, delay))
        return this.makeServerRequest(mintAddress, retryCount + 1)
      }

      throw error
    }
  }

  // Batch fetch multiple token metadata
  async fetchTokenInfoBatch(mintAddresses: string[]): Promise<Record<string, any>> {
    if (mintAddresses.length === 0) return {}

    const results: Record<string, any> = {}
    const uncachedMints: string[] = []

    // Check client cache first
    mintAddresses.forEach(mint => {
      const cached = this.getCachedData(`token_info_${mint}`)
      if (cached) {
        results[mint] = cached
      } else {
        uncachedMints.push(mint)
      }
    })

    // Fetch uncached mints from server in batches
    if (uncachedMints.length > 0) {
      const BATCH_SIZE = 50 // Server supports up to 50 per request

      for (let i = 0; i < uncachedMints.length; i += BATCH_SIZE) {
        const batch = uncachedMints.slice(i, i + BATCH_SIZE)

        try {
          const baseUrl = this.getBaseUrl()
          const response = await fetch(`${baseUrl}/api/jupiter/metadata`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ mints: batch })
          })

          if (!response.ok) {
            throw new Error(`Batch API error: ${response.status} ${response.statusText}`)
          }

          const batchResult = await response.json()

          if (batchResult.results) {
            Object.entries(batchResult.results).forEach(([mint, result]: [string, any]) => {
              if (result.data) {
                results[mint] = result.data
                this.setCachedData(`token_info_${mint}`, result.data)
              }
            })
          }
        } catch (error) {
          console.warn(`Failed to fetch batch token info:`, error)
          // Set defaults for failed batch
          batch.forEach(mint => {
            if (!results[mint]) {
              results[mint] = { decimals: 6, symbol: 'TOKEN', name: 'Unknown Token' }
            }
          })
        }
      }
    }

    return results
  }

  // Fetch token prices using our server API
  async fetchTokenPrices(mintAddresses: string[], options?: { timeout?: number; retries?: number }): Promise<Record<string, { price: number }>> {
    if (mintAddresses.length === 0) return {}

    const results: Record<string, { price: number }> = {}
    const uncachedMints: string[] = []

    // Check client cache first
    mintAddresses.forEach(mint => {
      const cached = this.getCachedData(`price_${mint}`)
      if (cached) {
        results[mint] = { price: cached }
      } else {
        uncachedMints.push(mint)
      }
    })

    // Fetch uncached prices from server in batches
    if (uncachedMints.length > 0) {
      const BATCH_SIZE = 100 // Server supports up to 100 per request

      for (let i = 0; i < uncachedMints.length; i += BATCH_SIZE) {
        const batch = uncachedMints.slice(i, i + BATCH_SIZE)

        try {
          const baseUrl = this.getBaseUrl()
          const response = await fetch(`${baseUrl}/api/tokens/prices`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ tokens: batch })
          })

          if (!response.ok) {
            throw new Error(`Price API error: ${response.status} ${response.statusText}`)
          }

          const priceResult = await response.json()

          if (priceResult.prices) {
            Object.entries(priceResult.prices).forEach(([mint, price]: [string, any]) => {
              if (typeof price === 'number') {
                results[mint] = { price: price }
                this.setCachedData(`price_${mint}`, price)
              }
            })
          }
        } catch (error) {
          console.warn(`Failed to fetch batch token prices:`, error)
          // Set zero prices for failed batch
          batch.forEach(mint => {
            if (!results[mint]) {
              results[mint] = { price: 0 }
            }
          })
        }
      }
    }

    return results
  }

  async checkIfFungibleToken(mintAddress: string): Promise<boolean> {
    const cacheKey = `fungible_${mintAddress}`
    const cached = this.getCachedData(cacheKey)
    if (cached !== null) return cached

    try {
      // Use our server API to check if token exists (if it exists, it's likely fungible)
      const tokenInfo = await this.fetchTokenInfo(mintAddress)
      const isFungible = tokenInfo !== null
      this.setCachedData(cacheKey, isFungible)
      return isFungible
    } catch (error) {
      console.warn(`Failed to check fungible status for ${mintAddress}:`, error)
      this.setCachedData(cacheKey, false)
      return false
    }
  }

  async checkFrozenStatus(mintAddress: string): Promise<boolean> {
    const cacheKey = `frozen_${mintAddress}`
    const cached = this.getCachedData(cacheKey)
    if (cached !== null) return cached

    try {
      // For now, we'll assume tokens are not frozen unless explicitly marked
      // This could be enhanced to check the actual token account state
      const isFrozen = false
      this.setCachedData(cacheKey, isFrozen)
      return isFrozen
    } catch (error) {
      console.warn(`Failed to check frozen status for ${mintAddress}:`, error)
      this.setCachedData(cacheKey, false)
      return false
    }
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
  progressCallback?: (progress: number) => void,
  forceRefresh: boolean = false,
): Promise<UserToken[]> {
  void progressCallback
  return fetchUserTokens(
    connection,
    userPublicKey,
    includeZeroBalance,
    includeNFTs,
    forceRefresh,
  )
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

export async function executeBulkSellAlt(
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
      feePerOperation: 0,
      totalOperations: 0,
      operationType: 'SELL' as FeeOperationType,
      sellFeeRate: 0,
      closeFeeRate: getFeeForOperation('CLOSE')
    }
  };

  try {
    const start = Date.now();
    const successfulSwaps: TokenToSell[] = [];

    if (request.tokens && request.tokens.length > 0) {
      const nonFrozenTokens = request.tokens.filter(token => !token.frozen);
      const frozenTokens = request.tokens.filter(token => token.frozen);

      console.log(`Executing bulk sell (ALT): ${nonFrozenTokens.length} sellable tokens, ${frozenTokens.length} frozen tokens`);

      frozenTokens.forEach(token => {
        result.failedSwaps.push({
          mintAddress: token.mintAddress,
          error: 'Token account is frozen and cannot be traded'
        });
      });

      if (nonFrozenTokens.length > 0) {
        const transactions: VersionedTransaction[] = [];
        const transactionTokens: TokenToSell[] = [];
        const transactionAmountOut: string[] = [];
        const transactionMetas: PreparedSwapMeta[] = [];

        let blockhashInfo: { blockhash: string; lastValidBlockHeight: number } | null = null;
        const getBlockhash = async () => {
          if (!blockhashInfo) {
            blockhashInfo = await connection.getLatestBlockhash('confirmed');
          }
          return blockhashInfo;
        };

        const BATCH_SIZE = 10;
        const batches: TokenToSell[][] = [];
        for (let i = 0; i < nonFrozenTokens.length; i += BATCH_SIZE) {
          batches.push(nonFrozenTokens.slice(i, i + BATCH_SIZE));
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);

        try {
          await Promise.all(batches.map(async (batch) => {
            const batchPromises = batch.map(async (token) => {
              try {
                if (token.sellAmount <= 0) {
                  throw new Error(`Invalid sell amount for token ${token.mintAddress}`);
                }

                const { tx, meta, outAmount } = await prepareBulkSwapTransaction({
                  userPublicKey,
                  inputMint: token.mintAddress,
                  outputMint: NATIVE_MINT.toBase58(),
                  amount: token.sellAmount,
                  slippageBps: request.slippage,
                  priorityFeeLamports: request.priorityFee,
                  feeAccount: FEE_CONFIG.DEV_WALLET,
                  feeBps: 50,
                  connection,
                });

                return {
                  success: true,
                  token,
                  tx,
                  meta,
                  amountOut: outAmount ?? '0',
                };
              } catch (error) {
                console.error(`Failed to prepare sell for ${token.mintAddress}:`, error);
                return { success: false, token, error };
              }
            });

            const results = await Promise.all(batchPromises);
            results.forEach(batchResult => {
              if (batchResult.success && batchResult.tx && batchResult.meta) {
                transactions.push(batchResult.tx);
                transactionTokens.push(batchResult.token);
                transactionAmountOut.push(batchResult.amountOut ?? '0');
                transactionMetas.push(batchResult.meta);
              } else {
                result.failedSwaps.push({
                  mintAddress: batchResult.token.mintAddress,
                  error: batchResult.error instanceof Error ? batchResult.error.message : 'Unknown error'
                });
              }
            });
          }));
        } finally {
          clearTimeout(timeoutId);
        }

        if (transactions.length > 0) {
          console.log(`Signing ${transactions.length} sell transactions...`);
          const signedTransactions = await signTransactionsWithFallback(
            transactions,
            signAllTransactions,
            async (tx) => {
              const [signed] = await signAllTransactions([tx]);
              return signed;
            },
          );
          const swapSignatures: string[] = [];

          const SEND_BATCH_SIZE = 6;
          for (let i = 0; i < signedTransactions.length; i += SEND_BATCH_SIZE) {
            const batch = signedTransactions.slice(i, i + SEND_BATCH_SIZE);
            const batchTokens = transactionTokens.slice(i, i + SEND_BATCH_SIZE);

            const sendPromises = batch.map(async (tx, idx) => {
              const globalIdx = i + idx;
              const meta = transactionMetas[globalIdx];
              try {
                const sendResult = await submitSignedSwap({
                  signedTx: tx,
                  prepared: meta,
                  connection,
                });
                return {
                  success: true,
                  signature: sendResult.signature,
                  tokenIdx: globalIdx,
                  via: sendResult.via,
                };
              } catch (error) {
                return { success: false, tokenIdx: globalIdx, error };
              }
            });

            const sendResults = await Promise.all(sendPromises);

            const confirmPromises = sendResults.map(async (sendResult) => {
              if (!sendResult.success) {
                result.failedSwaps.push({ mintAddress: transactionTokens[sendResult.tokenIdx].mintAddress, error: 'Failed to send' });
                return;
              }

              try {
                if (sendResult.via === 'raptor') {
                  await waitForRaptorConfirmation(sendResult.signature!, {
                    maxAttempts: 30,
                    intervalMs: 2000,
                  });

                  const amountOutLamports = Number.parseInt(
                    transactionAmountOut[sendResult.tokenIdx] ?? '0',
                    10,
                  );
                  const solReceived = Number.isFinite(amountOutLamports)
                    ? amountOutLamports / LAMPORTS_PER_SOL
                    : 0;

                  swapSignatures.push(sendResult.signature!);
                  successfulSwaps.push(transactionTokens[sendResult.tokenIdx]);
                  result.successfulSwaps.push({
                    mintAddress: transactionTokens[sendResult.tokenIdx].mintAddress,
                    solReceived,
                  });
                  result.totalReceived += solReceived;
                  console.log(`✅ Successfully sold ${transactionTokens[sendResult.tokenIdx].mintAddress} via Raptor`);
                  return;
                }

                const { blockhash, lastValidBlockHeight } = await getBlockhash();

                const confirmation = await connection.confirmTransaction({
                  signature: sendResult.signature!,
                  lastValidBlockHeight,
                  blockhash
                }, 'confirmed');

                if (confirmation.value.err) {
                  throw new Error(`Transaction failed confirmation: ${confirmation.value.err}`);
                }

                const txInfo = await connection.getTransaction(sendResult.signature!, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
                if (txInfo?.meta?.err) {
                  throw new Error('Transaction failed on-chain');
                }

                const accountIndex = txInfo?.transaction.message.staticAccountKeys.findIndex(key => key.toBase58() === userPublicKey);
                const preBalance = txInfo?.meta?.preBalances?.[accountIndex ?? 0] ?? 0;
                const postBalance = txInfo?.meta?.postBalances?.[accountIndex ?? 0] ?? 0;
                const solReceived = (postBalance - preBalance) / LAMPORTS_PER_SOL;

                swapSignatures.push(sendResult.signature!);
                successfulSwaps.push(transactionTokens[sendResult.tokenIdx]);
                result.successfulSwaps.push({
                  mintAddress: transactionTokens[sendResult.tokenIdx].mintAddress,
                  solReceived: solReceived > 0 ? solReceived : 0
                });
                result.totalReceived += solReceived > 0 ? solReceived : 0;
                console.log(`✅ Successfully sold ${transactionTokens[sendResult.tokenIdx].mintAddress}`);
              } catch (error: any) {
                result.failedSwaps.push({
                  mintAddress: transactionTokens[sendResult.tokenIdx].mintAddress,
                  error: error.message || 'Confirmation failed'
                });
              }
            });
            await Promise.all(confirmPromises);
          }
          result.signatures.push(...swapSignatures);
        }
      }
    }

    const tokensToCloseFromSwaps = successfulSwaps.filter(token => token.sellPercentage >= 100);
    const tokensToClose: UserToken[] = [...tokensToCloseFromSwaps];

    if (request.unsellableTokens && request.unsellableTokens.length > 0) {
      tokensToClose.push(...request.unsellableTokens.filter(token => !token.frozen));
    }

    if (tokensToClose.length > 0) {
      const closeResults = await closeTokenAccounts(
        tokensToClose,
        userPublicKey,
        connection,
        signAllTransactions,
        { successfulSwapsCount: result.successfulSwaps.length, totalSolReceived: result.totalReceived }
      );
      result.successfulCloses = closeResults.successful;
      result.failedCloses.push(...closeResults.failed);
      result.signatures.push(...closeResults.signatures);
    }

    if (result.successfulSwaps.length > 0 || result.successfulCloses.length > 0) {
      const sellFeeDistribution = calculateFeeDistribution('SELL', result.successfulSwaps.length, result.totalReceived);
      const closeFeeDistribution = calculateFeeDistribution('CLOSE', result.successfulCloses.length);
      const totalFees = sellFeeDistribution.totalFee + closeFeeDistribution.totalFee;
      result.feeInfo = {
        ...result.feeInfo,
        totalFees: totalFees,
        devFee: sellFeeDistribution.devFee + closeFeeDistribution.devFee,
        referralFee: sellFeeDistribution.referralFee + closeFeeDistribution.referralFee,
        totalOperations: result.successfulSwaps.length + result.successfulCloses.length,
        sellFeeRate: getFeeForOperation('SELL', result.totalReceived),
      };
      console.log(`🎉 Bulk sell (ALT) completed: ${result.successfulSwaps.length} swaps, ${result.successfulCloses.length} closes`);
      console.log(`⚡ Total processing time: ${Date.now() - start}ms`);
      console.log(`💰 Total fees: ${totalFees} SOL`);
    }

    result.success = result.successfulSwaps.length > 0 || result.successfulCloses.length > 0;
    return result;

  } catch (error) {
    console.error('Bulk sell execution error (ALT):', error);
    if (request.tokens && request.tokens.length > 0) {
      result.failedSwaps = request.tokens.map(token => ({
        mintAddress: token.mintAddress,
        error: error instanceof Error ? error.message : 'Unknown error during alt sell'
      }));
    }
    return result;
  }
}

