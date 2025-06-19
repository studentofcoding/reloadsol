import { Connection, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, SystemProgram } from '@solana/web3.js'
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createCloseAccountInstruction, createBurnInstruction } from '@solana/spl-token'
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
  solValue: number // Real SOL value from quote
  isLoadingPrice?: boolean
  frozen?: boolean // Whether the token account is frozen
  isNFT?: boolean // Whether the token is likely an NFT
}

export interface BulkSellRequest {
  tokens: UserToken[]
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

// Get SOL value estimate for a token with retry
export async function getTokenSolValue(
  mintAddress: string,
  balance: number,
  decimals: number
): Promise<number> {
  try {
    // Skip if balance is too small to avoid API calls for dust
    if (balance === 0) return 0
    
    const quote = await retryWithBackoff(() => 
      getSwapQuote(
        mintAddress,
        TOKENS.SOL,
        balance,
        300 // 3% slippage for estimation
      )
    )
    
    if (!quote || !quote.outAmount) return 0
    
    // Convert outAmount (in lamports) to SOL
    const solAmount = parseInt(quote.outAmount) / LAMPORTS_PER_SOL
    return solAmount
  } catch (error) {
    console.warn(`Failed to get SOL value for ${mintAddress}:`, error)
    return 0
  }
}

// Fetch user's token balances with real SOL values (fungible tokens only, excluding NFTs)
export async function fetchUserTokens(
  connection: Connection,
  userPublicKey: PublicKey,
  includeZeroBalance: boolean = false,
  includeNFTs: boolean = false
): Promise<UserToken[]> {
  try {
    // STEP 1: Initialize NFT cache first (one-time fetch)
    if (!nftCacheInitialized) {
      console.log('Initializing NFT cache...')
      const userNFTs = await fetchUserNFTMints(connection, userPublicKey)
      userNFTs.forEach(mint => nftMintCache.add(mint))
      nftCacheInitialized = true
      console.log(`NFT cache initialized with ${userNFTs.size} NFTs`)
    }

    // STEP 2: Get all token accounts
    const tokenAccounts = await connection.getTokenAccountsByOwner(userPublicKey, {
      programId: TOKEN_PROGRAM_ID,
    })

    const tokenPromises = tokenAccounts.value.map(async (tokenAccount) => {
      try {
        const accountData = tokenAccount.account.data
        
        // Parse token account data
        const mintBytes = accountData.slice(0, 32)
        const amountBytes = accountData.slice(64, 72)
        
        const mint = new PublicKey(mintBytes).toBase58()
        const amount = Number(amountBytes.readBigUInt64LE(0))
        
        // Include tokens with balance > 0 OR if includeZeroBalance is true
        if (amount > 0.000000000001 || includeZeroBalance) {
          // STEP 3: Check if it's an NFT first (using cache - no API call)
          const tokenIsNFT = nftMintCache.has(mint) && !isPumpFunToken(mint)
          
          // Skip NFTs unless explicitly requested
          if (tokenIsNFT && !includeNFTs) {
            console.log(`Skipping NFT: ${mint}`)
            return null
          }
          
          // STEP 4: Check frozen status (for non-NFTs or if including NFTs)
          const isFrozen = isTokenAccountFrozen(accountData)
          
          // STEP 5: Get token metadata (simplified - no NFT checking inside)
          const tokenInfo = await getTokenInfo(mint)
          
          // STEP 6: Additional Jupiter API check for frozen status if needed
          let jupiterFrozen = false
          if (!isFrozen && !tokenIsNFT) {
            jupiterFrozen = await checkTokenFrozenStatusWithJupiter(mint)
          }
          
          const token: UserToken = {
            mintAddress: mint,
            balance: amount,
            decimals: tokenInfo?.decimals || (tokenIsNFT ? 0 : 6),
            symbol: tokenInfo?.symbol || (tokenIsNFT ? 'NFT' : 'Unknown'),
            name: tokenInfo?.name || (tokenIsNFT ? 'NFT' : 'Unknown Token'),
            logoURI: tokenInfo?.logoURI,
            uiAmount: amount / Math.pow(10, tokenInfo?.decimals || (tokenIsNFT ? 0 : 6)),
            solValue: 0, // Will be updated for non-NFTs
            isLoadingPrice: !tokenIsNFT && !isFrozen && !jupiterFrozen, // Only load prices for tradeable tokens
            frozen: isFrozen || jupiterFrozen,
            isNFT: tokenIsNFT
          }
          
          console.log('token', token.symbol, 'frozen:', token.frozen, 'isNFT:', token.isNFT)
          return token
        }
        return null
      } catch (error) {
        console.warn('Error parsing token account:', error)
        return null
      }
    })

    const tokens = (await Promise.all(tokenPromises)).filter((token): token is UserToken => {
      if (!token) return false
      
      // If including zero balance, include all tokens
      if (includeZeroBalance) {
        return true
      }
      
      // Otherwise, only include tokens with meaningful balance
      return token.uiAmount > 0.000000000001
    })

    // STEP 7: Get SOL values only for tradeable tokens (non-NFT, non-frozen, with balance)
    const tradeableTokens = tokens.filter(token => 
      !token.isNFT && 
      !token.frozen && 
      token.uiAmount > 0.000000000001 && 
      token.isLoadingPrice
    )
    const nonTradeableTokens = tokens.filter(token => 
      token.isNFT || 
      token.frozen || 
      token.uiAmount <= 0.000000000001 ||
      !token.isLoadingPrice
    )
    
    console.log(`Fetching prices for ${tradeableTokens.length} tradeable tokens, skipping ${nonTradeableTokens.length} non-tradeable tokens`)
    
    const BATCH_SIZE = 10
    for (let i = 0; i < tradeableTokens.length; i += BATCH_SIZE) {
      const batch = tradeableTokens.slice(i, i + BATCH_SIZE)
      
      const pricePromises = batch.map(async (token) => {
        const solValue = await getTokenSolValue(
          token.mintAddress,
          token.balance,
          token.decimals
        )
        console.log('solValue of', token.symbol, solValue)
        return { ...token, solValue, isLoadingPrice: false }
      })
      
      const updatedBatch = await Promise.all(pricePromises)
      
      // Update the original tokens array
      updatedBatch.forEach((updatedToken, batchIndex) => {
        const originalIndex = i + batchIndex
        tradeableTokens[originalIndex] = updatedToken
      })
      
      // Small delay between batches to be nice to the API
      if (i + BATCH_SIZE < tradeableTokens.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // STEP 8: Categorize tokens after price fetching
    const allTokens = [...tradeableTokens, ...nonTradeableTokens]
    
    // Separate sellable vs unsellable among the tradeable tokens
    const sellableTokens = tradeableTokens.filter(token => 
      token.solValue >= 0.001 || isPumpFunToken(token.mintAddress)
    )
    const unsellableTokens = tradeableTokens.filter(token => 
      token.solValue < 0.001 && !isPumpFunToken(token.mintAddress)
    )
    
    // Mark all non-tradeable tokens as not loading
    nonTradeableTokens.forEach(token => {
      token.isLoadingPrice = false
      if (token.uiAmount <= 0.000000000001) {
        token.solValue = 0
      }
    })

    console.log(`Categorized tokens: ${sellableTokens.length} sellable, ${unsellableTokens.length} unsellable, ${nonTradeableTokens.filter(t => t.frozen).length} frozen, ${nonTradeableTokens.filter(t => t.isNFT).length} NFTs`)
    
    return allTokens.sort((a, b) => {
      // Check if tokens are sellable (SOL value >= 0.001 OR pump.fun token) AND not frozen
      const aIsSellable = (a.solValue >= 0.001 || isPumpFunToken(a.mintAddress)) && !a.frozen
      const bIsSellable = (b.solValue >= 0.001 || isPumpFunToken(b.mintAddress)) && !b.frozen
      
      // Check if tokens are frozen
      const aIsFrozen = a.frozen
      const bIsFrozen = b.frozen
      
      // Sort order: sellable tokens first, then unsellable tokens, then frozen tokens last
      if (aIsSellable && !bIsSellable) return -1
      if (!aIsSellable && bIsSellable) return 1
      
      // Within the same category, handle frozen tokens
      if (!aIsFrozen && bIsFrozen) return -1
      if (aIsFrozen && !bIsFrozen) return 1
      
      // Then sort by SOL value within sellable tokens, or alphabetically for others
      if (aIsSellable && bIsSellable) {
        return b.solValue - a.solValue
      } else {
        return (a.symbol || '').localeCompare(b.symbol || '')
      }
    })
  } catch (error) {
    console.error('Error fetching user tokens:', error)
    return []
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
    // Include tokens with zero balance OR tokens with SOL value < 0.001 (unsellable), but exclude pump.fun tokens AND frozen tokens
    return allTokens.filter(token => 
      !token.frozen && (
        token.uiAmount <= 0.000000000001 || 
        (token.solValue < 0.001 && !isPumpFunToken(token.mintAddress))
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
    // Try Jupiter's Token API first
    const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`)
    
    if (response.ok) {
      const tokenData = await response.json()
      return {
        decimals: tokenData.decimals,
        symbol: tokenData.symbol,
        name: tokenData.name,
        logoURI: tokenData.logoURI
      }
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
    const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`)
    
    if (response.ok) {
      const tokenData = await response.json()
      // Jupiter API might have frozen status or we can infer from other properties
      return tokenData.frozen === true || tokenData.status === 'frozen'
    }
  } catch (error) {
    console.warn(`Failed to check frozen status with Jupiter for ${mintAddress}:`, error)
  }
  
  return false
}

// Check if a token is a fungible token using Jupiter API
async function isFungibleTokenWithJupiter(mintAddress: string): Promise<boolean> {
  try {
    const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`)
    
    if (response.ok) {
      // If Jupiter API returns data for this token, it's likely a fungible token
      return true
    }
  } catch (error) {
    console.warn(`Failed to check fungible status with Jupiter for ${mintAddress}:`, error)
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
    const successfulSwaps: UserToken[] = []
    
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
      const quotes: Array<{ token: UserToken; quote: SwapQuote | null }> = []
      
      for (const token of nonFrozenTokens) {
        const quote = await getSwapQuote(
          token.mintAddress,
          TOKENS.SOL,
          token.balance, // Use full balance
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
        const swapTokens: UserToken[] = []
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

    // Step 4: Close token accounts for successful swaps AND selected unsellable tokens
    const tokensToClose = [...successfulSwaps]
    
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
      feePerOperation: 0, // Will be calculated as 1% of SOL budget
      totalOperations: 0,
      operationType: 'BUY' as FeeOperationType
    }
  }

  try {
    // Calculate amount per token
    const amountPerToken = Math.floor((request.solAmount * LAMPORTS_PER_SOL) / request.tokenMints.length)
    
    // Get quotes for all tokens
    const quotes: Array<{ mint: string; quote: SwapQuote | null }> = []
    
    for (const mint of request.tokenMints) {
      const quote = await getSwapQuote(
        TOKENS.SOL,
        mint,
        amountPerToken,
        request.slippage
      )
      quotes.push({ mint, quote })
    }

    // Filter successful quotes
    const validQuotes = quotes.filter(q => q.quote !== null)
    
    if (validQuotes.length === 0) {
      throw new Error('No valid quotes received for any tokens')
    }

    // Get swap transactions
    const transactions: VersionedTransaction[] = []
    const transactionMints: string[] = []

    for (const { mint, quote } of validQuotes) {
      if (!quote) continue

      // Include fee instructions in the swap transaction
      // For buy: 0.5% of total SOL budget divided by number of tokens
      const feePerTransaction = (request.solAmount * FEE_CONFIG.FEES.BUY_PERCENTAGE) / (100 * request.tokenMints.length)
      const feeInstructions = createJupiterFeeInstructions(
        new PublicKey(userPublicKey),
        'BUY',
        1, // 1 token per transaction
        feePerTransaction
      )

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
        transactions.push(tx)
        transactionMints.push(mint)
      } else {
        result.failedPurchases.push({
          mintAddress: mint,
          error: 'Failed to get swap transaction'
        })
      }
    }

    if (transactions.length === 0) {
      throw new Error('No valid transactions could be created')
    }

    // Sign all transactions
    const signedTransactions = await signAllTransactions(transactions)

    // Send transactions
    const signatures: string[] = []
    
    for (let i = 0; i < signedTransactions.length; i++) {
      try {
        const signature = await connection.sendTransaction(signedTransactions[i], {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        })

        // Confirm transaction
        const confirmation = await connection.confirmTransaction(signature, 'confirmed')
        
        if (confirmation.value.err) {
          result.failedPurchases.push({
            mintAddress: transactionMints[i],
            error: `Transaction failed: ${confirmation.value.err}`
          })
        } else {
          signatures.push(signature)
          result.successfulPurchases.push({
            mintAddress: transactionMints[i],
            amount: amountPerToken,
          })
        }
      } catch (error) {
        result.failedPurchases.push({
          mintAddress: transactionMints[i],
          error: `Transaction error: ${error}`
        })
      }
    }

    result.signatures = signatures
    result.totalSpent = (amountPerToken * result.successfulPurchases.length) / LAMPORTS_PER_SOL
    result.success = result.successfulPurchases.length > 0

    // Calculate and populate fee information (fees are now included inline in transactions)
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
      
      console.log(`Fees included inline: ${feeDistribution.totalFee} SOL total (0.5% of ${request.solAmount} SOL budget) (Dev: ${feeDistribution.devFee})`)
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
    } else if (token.solValue >= 0.001 || isPumpFunToken(token.mintAddress)) {
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
        
        console.log(`Token ${token.mintAddress}: balance=${currentBalance}, uiAmount=${currentUiAmount}, solValue=${token.solValue}`)
        
        // For tokens with balance but low SOL value, we need to burn first
        if (parseInt(currentBalance) > 0) {
          if (token.solValue < 0.001) {
            console.log(`Creating burn instruction for unsellable token ${token.mintAddress} (${currentBalance} tokens, SOL value ${token.solValue})`)
            
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

