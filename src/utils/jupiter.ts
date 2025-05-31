import { Connection, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey, TransactionMessage } from '@solana/web3.js'
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, createCloseAccountInstruction, createBurnInstruction } from '@solana/spl-token'
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
  unsellableTokens?: UserToken[] // Optional unsellable tokens to close
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
  userPublicKey: PublicKey,
  includeZeroBalance: boolean = false
): Promise<UserToken[]> {
  try {
    const tokenAccounts = await connection.getTokenAccountsByOwner(userPublicKey, {
      programId: TOKEN_PROGRAM_ID,
    })

    const tokenPromises = tokenAccounts.value.map(async (tokenAccount) => {
      try {
        const accountData = tokenAccount.account.data
        
        // Parse token account data
        const mintBytes = accountData.slice(0, 32)
        const ownerBytes = accountData.slice(32, 64)
        const amountBytes = accountData.slice(64, 72)
        
        const mint = new PublicKey(mintBytes).toBase58()
        const amount = Number(amountBytes.readBigUInt64LE(0))
        
        // Include tokens with balance > 0 OR if includeZeroBalance is true
        if (amount > 0.000000000001 || includeZeroBalance) {
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
          console.log('token', token)

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

    // Second pass: get SOL values for tokens with meaningful balance
    const tokensWithBalance = tokens.filter(token => token.uiAmount > 0.000000000001)
    const tokensZeroBalance = tokens.filter(token => token.uiAmount <= 0.000000000001)
    
    const BATCH_SIZE = 10
    for (let i = 0; i < tokensWithBalance.length; i += BATCH_SIZE) {
      const batch = tokensWithBalance.slice(i, i + BATCH_SIZE)
      
      const pricePromises = batch.map(async (token) => {
        const solValue = await getTokenSolValue(
          token.mintAddress,
          token.balance,
          token.decimals
        )
        console.log('solValue of', token.mintAddress, solValue)
        return { ...token, solValue, isLoadingPrice: false }
      })
      
      const updatedBatch = await Promise.all(pricePromises)
      
      // Update the original tokens array
      updatedBatch.forEach((updatedToken, batchIndex) => {
        const originalIndex = i + batchIndex
        tokensWithBalance[originalIndex] = updatedToken
      })
      
      // Small delay between batches to be nice to the API
      if (i + BATCH_SIZE < tokensWithBalance.length) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // Now separate tokens based on their SOL value after fetching prices
    // Sellable tokens must have SOL value >= 0.001 (meaningful value)
    const sellableTokens = tokensWithBalance.filter(token => token.solValue >= 0.001)
    const unsellableTokens = tokensWithBalance.filter(token => token.solValue < 0.001)

    // Mark zero balance tokens and unsellable tokens as not loading
    const allZeroBalanceTokens = [
      ...tokensZeroBalance.map(token => ({
        ...token,
        solValue: 0,
        isLoadingPrice: false
      })),
      ...unsellableTokens.map(token => ({
        ...token,
        isLoadingPrice: false
      }))
    ]

    // Combine and sort: sellable tokens first (by SOL value), then zero/unsellable tokens
    const allTokens = [...sellableTokens, ...allZeroBalanceTokens]
    
    return allTokens.sort((a, b) => {
      // First sort by whether they have meaningful SOL value (>= 0.001)
      if (a.solValue >= 0.001 && b.solValue < 0.001) return -1
      if (a.solValue < 0.001 && b.solValue >= 0.001) return 1
      
      // Then sort by SOL value within sellable tokens, or alphabetically for unsellable tokens
      if (a.solValue >= 0.001 && b.solValue >= 0.001) {
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

// New function to fetch only zero-balance tokens for closing
export async function fetchZeroBalanceTokens(
  connection: Connection,
  userPublicKey: PublicKey
): Promise<UserToken[]> {
  try {
    const allTokens = await fetchUserTokens(connection, userPublicKey, true)
    // Include tokens with zero balance OR tokens with SOL value < 0.001 (unsellable)
    return allTokens.filter(token => token.uiAmount <= 0.000000000001 || token.solValue < 0.001)
  } catch (error) {
    console.error('Error fetching zero balance tokens:', error)
    return []
  }
}

// Simple token info lookup (in production, use a proper token registry)
async function getTokenInfo(mintAddress: string): Promise<{ decimals: number; symbol: string; name: string; logoURI?: string } | null> {
  try {
    // First try Jupiter's Token API
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

    // This is a simplified lookup - in production you'd use Jupiter's token list or similar
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
    const successfulSwaps: UserToken[] = []
    
    // Only process swaps if there are tokens to sell
    if (request.tokens && request.tokens.length > 0) {
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
        // Mark all tokens as failed to sell
        result.failedSales = request.tokens.map(token => ({
          mintAddress: token.mintAddress,
          error: 'No valid quote available'
        }))
      } else {
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
          
          result.signatures.push(...swapSignatures)
        }
      }
    }

    // Step 4: Close token accounts for successful swaps AND selected unsellable tokens
    const tokensToClose = [...successfulSwaps]
    
    // Add unsellable tokens to the close list if provided
    if (request.unsellableTokens && request.unsellableTokens.length > 0) {
      tokensToClose.push(...request.unsellableTokens)
      console.log(`Adding ${request.unsellableTokens.length} unsellable tokens to close list`)
    }
    
    if (tokensToClose.length > 0) {
      try {
        const closeResults = await closeTokenAccounts(
          tokensToClose,
          userPublicKey,
          connection,
          signAllTransactions
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

    // Operation is successful if we have successful sales OR successful closes
    result.success = result.successfulSales.length > 0 || result.successfulCloses.length > 0
    return result
  } catch (error) {
    console.error('Bulk sell execution error:', error)
    
    // Only mark tokens as failed to sell if we actually have tokens to sell
    if (request.tokens && request.tokens.length > 0) {
      result.failedSales = request.tokens.map(token => ({
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
  signAllTransactions: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
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