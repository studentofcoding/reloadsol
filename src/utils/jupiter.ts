import { Connection, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { JUPITER_API, TOKENS } from './solana'
import { SwapQuote, SwapTransaction, BulkBuyRequest, BulkBuyResult, TokenPurchase } from '@/types'

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