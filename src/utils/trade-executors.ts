import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js'
import { getSwapQuote, getSwapTransaction } from '@/utils/jupiter'
import { logTradeOperation } from '@/utils/logger'

// -----------------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------------

export interface TradeExecutionParams {
  tokenAddress: string
  tokenSymbol: string | null
  inputMint: string
  outputMint: string
  amount: number // in lamports for input token
  slippageBps: number
  userPublicKey: string
  priorityFee?: number
}

export interface TradeExecutionResult {
  success: boolean
  signature?: string
  inputAmount: string
  outputAmount: string
  fees: {
    totalFees: number
    feePercentage: number
  }
  provider: string
  rpcUsed: string
  responseTime: number
  error?: string
}

export interface TradeExecutor {
  executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult>
  executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult>
}

// -----------------------------------------------------------------------------------
// Simulation Executor – chain-less paper trading using quote-comparison utils
// -----------------------------------------------------------------------------------

class SimulationExecutor implements TradeExecutor {
  async executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    try {
      const { compareTradeQuotes } = await import('@/utils/trade-comparison')
      const comparison = await compareTradeQuotes({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount.toString(),
        slippageBps: params.slippageBps,
        userPublicKey: params.userPublicKey
      })

      if (comparison.bestQuote && comparison.bestQuote.success) {
        const best = comparison.bestQuote
        return {
          success: true,
          inputAmount: best.inAmount,
          outputAmount: best.outAmount,
          fees: {
            totalFees: best.fees?.totalFeeLamports ? best.fees.totalFeeLamports / 1e9 : 0,
            feePercentage: best.fees?.feePercentage || 0
          },
          provider: best.provider,
          rpcUsed: 'simulation',
          responseTime: best.responseTime
        }
      }

      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'none',
        rpcUsed: 'none',
        responseTime: 0,
        error: 'No successful quotes available'
      }
    } catch (error: any) {
      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'none',
        rpcUsed: 'none',
        responseTime: 0,
        error: error?.message || 'Simulation failed'
      }
    }
  }

  async executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    // identical flow for opposite direction
    return this.executeBuy(params)
  }
}

// -----------------------------------------------------------------------------------
// Real Trade Executor – sends actual transactions via Jupiter + Shyft RPC
// -----------------------------------------------------------------------------------

class RealTradeExecutor implements TradeExecutor {
  constructor(
    private connection: Connection,
    private signer: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>
  ) {}

  executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    return this.executeSwap(params, 'buy')
  }

  executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    return this.executeSwap(params, 'sell')
  }

  private async executeSwap(params: TradeExecutionParams, direction: 'buy' | 'sell'): Promise<TradeExecutionResult> {
    const started = Date.now()
    logTradeOperation(`Real Trade ${direction.toUpperCase()} Started`, {
      tokenAddress: params.tokenAddress,
      tokenSymbol: params.tokenSymbol,
      amount: params.amount,
      slippageBps: params.slippageBps,
      userPublicKey: params.userPublicKey,
      direction
    })

    try {
      const quote = await getSwapQuote(
        params.inputMint,
        params.outputMint,
        params.amount,
        params.slippageBps
      )
      if (!quote) throw new Error('No valid Jupiter quote available')

      const swapTx = await getSwapTransaction(
        quote,
        params.userPublicKey,
        params.priorityFee || 0,
        []
      )
      if (!swapTx) throw new Error('Failed to create Jupiter swap transaction')

      const tx = VersionedTransaction.deserialize(Buffer.from(swapTx.swapTransaction, 'base64'))
      const [signedTx] = await this.signer([tx])

      // retry-send logic
      let signature: string | undefined
      let attempts = 0
      while (attempts < 3) {
        try {
          signature = await this.connection.sendTransaction(signedTx, { skipPreflight: false, maxRetries: 1 })
          break
        } catch (e) {
          attempts++
          if (attempts === 3) throw e
          await new Promise(r => setTimeout(r, 1000 * attempts))
        }
      }
      if (!signature) throw new Error('Failed to send transaction')

      const confirmPromise = this.connection.confirmTransaction(signature, 'confirmed')
      const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('Confirmation timeout')), 30000))
      await Promise.race([confirmPromise, timeoutPromise])

      const elapsed = Date.now() - started
      const result: TradeExecutionResult = {
        success: true,
        signature,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        fees: {
          totalFees: quote.platformFee ? parseInt(quote.platformFee.amount) / 1e9 : 0,
          feePercentage: quote.platformFee ? quote.platformFee.feeBps / 100 : 0
        },
        provider: 'jupiter',
        rpcUsed: 'shyft',
        responseTime: elapsed
      }

      logTradeOperation(`Real Trade ${direction.toUpperCase()} SUCCESS`, result)
      return result
    } catch (error: any) {
      const elapsed = Date.now() - started
      logTradeOperation(`Real Trade ${direction.toUpperCase()} FAILED`, {
        tokenSymbol: params.tokenSymbol,
        direction,
        responseTime: elapsed
      }, error)
      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'jupiter',
        rpcUsed: 'shyft',
        responseTime: elapsed,
        error: error?.message || 'Real trade failed'
      }
    }
  }
}

// -----------------------------------------------------------------------------------
// Factory + helper utilities
// -----------------------------------------------------------------------------------

export function createTradeExecutor(
  isSimulated: boolean,
  connection?: Connection,
  signer?: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): TradeExecutor {
  if (isSimulated) return new SimulationExecutor()
  if (!connection || !signer) throw new Error('Connection and signer required for real trading')
  return new RealTradeExecutor(connection, signer)
}

export function loadTradingKeypair(keypairPath?: string): Keypair {
  const envJson = process.env.TRADING_KEYPAIR_JSON
  if (envJson) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envJson)))
  if (keypairPath) {
    const fs = require('fs')
    const data = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
    return Keypair.fromSecretKey(Uint8Array.from(data))
  }
  throw new Error('Trading keypair not provided. Set TRADING_KEYPAIR_JSON or supply keypairPath.')
}

export function createSignerFromKeypair(keypair: Keypair) {
  return async (txs: VersionedTransaction[]): Promise<VersionedTransaction[]> => {
    txs.forEach(tx => tx.sign([keypair]))
    return txs
  }
}

export { SimulationExecutor, RealTradeExecutor } 