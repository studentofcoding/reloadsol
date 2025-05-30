import { Connection, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey, TransactionMessage } from '@solana/web3.js'
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token'
import { JUPITER_API, TOKENS } from './solana'
import { SwapQuote, SwapTransaction, BulkBuyRequest, BulkBuyResult, TokenPurchase } from '@/types'

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
}

export interface BulkSellRequest {
  tokens: UserToken[]
  slippage: number
  priorityFee: number
}

export interface BulkSellResult {
  success: boolean
  successfulSales: Array<{ mintAddress: string; solReceived: number }>
  failedSales: Array<{ mintAddress: string; error: string }>
  successfulCloses: string[]
  failedCloses: Array<{ mintAddress: string; error: string }>
  totalReceived: number
  signatures: string[]
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

// Get swap transaction
export async function getSwapTransaction(
  quote: SwapQuote,
  userPublicKey: string,
  priorityFeeLamports: number = 0
): Promise<SwapTransaction | null> {
  try {
    const response = await fetch(JUPITER_API.swap, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        priorityLevelWithMaxLamports: {
          priorityLevel: 'medium',
          maxLamports: priorityFeeLamports,
        },
      }),
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

// Fetch user's token balances with real SOL values
export async function fetchUserTokens(
  connection: Connection,
  userPublicKey: PublicKey
): Promise<UserToken[]> {
  try {
    const tokenAccountsResponse = await connection.getTokenAccountsByOwner(userPublicKey, {
      programId: TOKEN_PROGRAM_ID,
    })

    const userTokens: UserToken[] = []

    // First pass: collect all tokens with basic info
    const tokenPromises = tokenAccountsResponse.value.map(async ({ account, pubkey }) => {
      try {
        const accountData = account.data
        
        // Parse token account data
        const mintBytes = accountData.slice(0, 32)
        const ownerBytes = accountData.slice(32, 64)
        const amountBytes = accountData.slice(64, 72)
        
        const mint = new PublicKey(mintBytes).toBase58()
        const amount = Number(amountBytes.readBigUInt64LE(0))
        
        if (amount > 0) {
          // Try to get token metadata
          const tokenInfo = await getTokenInfo(mint)
          
          const token: UserToken = {
            mintAddress: mint,
            balance: amount,
            decimals: tokenInfo?.decimals || 6,
            symbol: tokenInfo?.symbol || 'Unknown',
            name: tokenInfo?.name || 'Unknown Token',
            logoURI: tokenInfo?.logoURI,
            uiAmount: amount / Math.pow(10, tokenInfo?.decimals || 6),
            solValue: 0, // Will be updated
            isLoadingPrice: true
          }
          
          return token
        }
        return null
      } catch (error) {
        console.warn('Error parsing token account:', error)
        return null
      }
    })

    const tokens = (await Promise.all(tokenPromises)).filter((token): token is UserToken => 
      token !== null && token.uiAmount > 0.000001
    )

    // Second pass: get SOL values in batches to avoid overwhelming the API
    const BATCH_SIZE = 5
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const batch = tokens.slice(i, i + BATCH_SIZE)
      
      const pricePromises = batch.map(async (token) => {
        const solValue = await getTokenSolValue(
          token.mintAddress,
          token.balance,
          token.decimals
        )
        return { ...token, solValue, isLoadingPrice: false }
      })
      
      const updatedBatch = await Promise.all(pricePromises)
      
      // Update the original tokens array
      updatedBatch.forEach((updatedToken, batchIndex) => {
        const originalIndex = i + batchIndex
        tokens[originalIndex] = updatedToken
      })
      
      // Small delay between batches to be nice to the API
      if (i + BATCH_SIZE < tokens.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    return tokens.sort((a, b) => b.solValue - a.solValue) // Sort by SOL value descending
  } catch (error) {
    console.error('Error fetching user tokens:', error)
    return []
  }
}

// Simple token info lookup (in production, use a proper token registry)
async function getTokenInfo(mintAddress: string): Promise<{ decimals: number; symbol: string; name: string; logoURI?: string } | null> {
  try {
    // This is a simplified lookup - in production you'd use Jupiter's token list or similar
    const commonTokens: Record<string, any> = {
      [TOKENS.SOL]: { decimals: 9, symbol: 'SOL', name: 'Solana' },
      [TOKENS.USDC]: { decimals: 6, symbol: 'USDC', name: 'USD Coin' },
      [TOKENS.USDT]: { decimals: 6, symbol: 'USDT', name: 'Tether USD' },
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
function isPumpFunToken(mintAddress: string): boolean {
  return mintAddress.includes('pump') || mintAddress.endsWith('pump')
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
    successfulSales: [],
    failedSales: [],
    successfulCloses: [],
    failedCloses: [],
    totalReceived: 0,
    signatures: [],
  }

  try {
    // Step 1: Get quotes for all tokens to sell
    const quotes: Array<{ token: UserToken; quote: SwapQuote | null }> = []
    
    for (const token of request.tokens) {
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
      throw new Error('No valid quotes received for any tokens')
    }

    // Step 2: Create swap transactions
    const swapTransactions: VersionedTransaction[] = []
    const swapTokens: UserToken[] = []
    const swapQuotes: SwapQuote[] = []

    for (const { token, quote } of validQuotes) {
      if (!quote) continue

      const swapTransaction = await getSwapTransaction(
        quote,
        userPublicKey,
        request.priorityFee
      )

      if (swapTransaction) {
        const tx = VersionedTransaction.deserialize(
          Buffer.from(swapTransaction.swapTransaction, 'base64')
        )
        swapTransactions.push(tx)
        swapTokens.push(token)
        swapQuotes.push(quote)
      } else {
        result.failedSales.push({
          mintAddress: token.mintAddress,
          error: 'Failed to create swap transaction'
        })
      }
    }

    if (swapTransactions.length === 0) {
      throw new Error('No valid swap transactions could be created')
    }

    // Step 3: Sign and send swap transactions
    const signedSwapTransactions = await signAllTransactions(swapTransactions)
    
    const swapSignatures: string[] = []
    const successfulSwaps: UserToken[] = []
    
    for (let i = 0; i < signedSwapTransactions.length; i++) {
      try {
        const signature = await connection.sendTransaction(signedSwapTransactions[i], {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        })

        // Confirm transaction
        const confirmation = await connection.confirmTransaction(signature, 'confirmed')
        
        if (confirmation.value.err) {
          result.failedSales.push({
            mintAddress: swapTokens[i].mintAddress,
            error: `Swap transaction failed: ${confirmation.value.err}`
          })
        } else {
          swapSignatures.push(signature)
          successfulSwaps.push(swapTokens[i])
          
          // Calculate actual SOL received from the quote
          const quote = swapQuotes[i]
          const solReceived = parseInt(quote.outAmount) / LAMPORTS_PER_SOL
          
          result.successfulSales.push({
            mintAddress: swapTokens[i].mintAddress,
            solReceived: solReceived
          })
          result.totalReceived += solReceived
        }
      } catch (error) {
        result.failedSales.push({
          mintAddress: swapTokens[i].mintAddress,
          error: `Swap error: ${error}`
        })
      }
    }

    // Step 4: Close token accounts for successful swaps
    if (successfulSwaps.length > 0) {
      try {
        const closeResults = await closeTokenAccounts(
          successfulSwaps,
          userPublicKey,
          connection,
          signAllTransactions
        )
        
        result.successfulCloses = closeResults.successful
        result.failedCloses = closeResults.failed
        result.signatures.push(...swapSignatures, ...closeResults.signatures)
      } catch (error) {
        console.error('Error closing accounts:', error)
        // Mark all as failed to close
        result.failedCloses = successfulSwaps.map(token => ({
          mintAddress: token.mintAddress,
          error: 'Failed to close account'
        }))
      }
    }

    result.success = result.successfulSales.length > 0
    return result
  } catch (error) {
    console.error('Bulk sell execution error:', error)
    result.failedSales = request.tokens.map(token => ({
      mintAddress: token.mintAddress,
      error: error instanceof Error ? error.message : 'Unknown error'
    }))
    return result
  }
}

// Close token accounts after successful sales with improved error handling
async function closeTokenAccounts(
  tokens: UserToken[],
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
    const closeInstructions = []
    const closeTokens = []

    // Create close instructions for each token with better error handling
    for (const token of tokens) {
      try {
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

        // Check if account exists and has zero balance before closing
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

        const closeInstruction = createCloseAccountInstruction(
          tokenAccount,
          new PublicKey(userPublicKey),
          new PublicKey(userPublicKey)
        )

        closeInstructions.push(closeInstruction)
        closeTokens.push(token)
      } catch (error) {
        console.error(`Failed to prepare close for ${token.mintAddress}:`, error)
        result.failed.push({
          mintAddress: token.mintAddress,
          error: `Failed to create close instruction: ${error instanceof Error ? error.message : 'Unknown error'}`
        })
      }
    }

    if (closeInstructions.length > 0) {
      try {
        // Create transaction with close instructions
        const { blockhash } = await connection.getLatestBlockhash('confirmed')
        
        const messageV0 = new TransactionMessage({
          payerKey: new PublicKey(userPublicKey),
          recentBlockhash: blockhash,
          instructions: closeInstructions
        }).compileToV0Message()

        const transaction = new VersionedTransaction(messageV0)
        const signedTransactions = await signAllTransactions([transaction])

        // Send close transaction with retry mechanism
        const signature = await retryWithBackoff(async () => {
          return await connection.sendTransaction(signedTransactions[0], {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3
          })
        })

        const confirmation = await connection.confirmTransaction(signature, 'confirmed')
        
        if (confirmation.value.err) {
          const errorMsg = `Close transaction failed: ${JSON.stringify(confirmation.value.err)}`
          console.error(errorMsg)
          closeTokens.forEach(token => {
            result.failed.push({
              mintAddress: token.mintAddress,
              error: errorMsg
            })
          })
        } else {
          result.signatures.push(signature)
          result.successful = closeTokens.map(token => token.mintAddress)
          console.log(`Successfully closed ${closeTokens.length} token accounts`)
        }
      } catch (transactionError) {
        console.error('Transaction creation/sending failed:', transactionError)
        closeTokens.forEach(token => {
          result.failed.push({
            mintAddress: token.mintAddress,
            error: `Transaction failed: ${transactionError instanceof Error ? transactionError.message : 'Unknown transaction error'}`
          })
        })
      }
    } else {
      console.log('No token accounts to close')
    }

    return result
  } catch (error) {
    console.error('Close accounts function failed:', error)
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

      const swapTransaction = await getSwapTransaction(
        quote,
        userPublicKey,
        request.priorityFee
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