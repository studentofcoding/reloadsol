// Trade executor classes extracted from src/app/api/trending/track/route.ts (REL-19).
import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js'
import { getSwapQuote } from '@/utils/jupiter'
import { prepareSwapTransaction, submitSignedSwap, confirmSwapSignature } from '@/utils/swap-executor'
import { compareTradeQuotes } from '@/utils/trade-comparison'
import { logTradeOperation } from '@/utils/unified-logger'
import { shouldEnableNotifications } from '@/utils/discord'
import { sendSyncTradeNotificationDiscord } from './discord'
import type {
  TradeExecutionParams,
  TradeExecutionResult,
  TradeExecutor,
  SyncedTradeResult,
} from './types'

export class SimulationExecutor implements TradeExecutor {
  async executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    try {
      const comparison = await compareTradeQuotes({
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount.toString(),
        slippageBps: params.slippageBps,
        userPublicKey: params.userPublicKey
      })

      if (comparison.bestQuote && comparison.bestQuote.success) {
        const bestQuote = comparison.bestQuote
        return {
          success: true,
          inputAmount: bestQuote.inAmount,
          outputAmount: bestQuote.outAmount,
          fees: {
            totalFees: bestQuote.fees?.totalFeeLamports ? bestQuote.fees.totalFeeLamports / 1e9 : 0,
            feePercentage: bestQuote.fees?.feePercentage || 0
          },
          provider: bestQuote.provider,
          rpcUsed: 'simulation',
          responseTime: bestQuote.responseTime,
        }
      } else {
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
      }
    } catch (error) {
      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'none',
        rpcUsed: 'none',
        responseTime: 0,
        error: error instanceof Error ? error.message : 'Simulation failed'
      }
    }
  }

  async executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    // Same logic as executeBuy but for sell direction
    return this.executeBuy(params)
  }
}

// Modified SimulationExecutor to use Jupiter quotes for synchronization
export class SyncedSimulationExecutor implements TradeExecutor {
  async executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    try {
      // Use Jupiter quote directly (same as real trading) instead of multi-provider comparison
      console.log(`🔄 Getting Jupiter quote for simulation ${params.tokenSymbol}...`)
      const quote = await getSwapQuote(
        params.inputMint,
        params.outputMint,
        params.amount,
        params.slippageBps
      )

      if (!quote) {
        return {
          success: false,
          inputAmount: params.amount.toString(),
          outputAmount: '0',
          fees: { totalFees: 0, feePercentage: 0 },
          provider: 'jupiter',
          rpcUsed: 'simulation',
          responseTime: 0,
          error: 'No Jupiter quote available'
        }
      }

      return {
        success: true,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        fees: {
          totalFees: quote.platformFee ? parseInt(quote.platformFee.amount) / 1e9 : 0,
          feePercentage: quote.platformFee ? quote.platformFee.feeBps / 100 : 0
        },
        provider: 'jupiter',
        rpcUsed: 'simulation',
        responseTime: 100, // Simulated response time
      }
    } catch (error) {
      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'jupiter',
        rpcUsed: 'simulation',
        responseTime: 0,
        error: error instanceof Error ? error.message : 'Simulation failed'
      }
    }
  }

  async executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    return this.executeBuy(params)
  }
}

// Real trade executor (new implementation)
export class RealTradeExecutor implements TradeExecutor {
  private connection: Connection
  private signer: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>

  constructor(connection: Connection, signer: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>) {
    this.connection = connection
    this.signer = signer
  }

  async executeBuy(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    return this.executeSwap(params, 'buy')
  }

  async executeSell(params: TradeExecutionParams): Promise<TradeExecutionResult> {
    return this.executeSwap(params, 'sell')
  }

  private async executeSwap(params: TradeExecutionParams, direction: 'buy' | 'sell'): Promise<TradeExecutionResult> {
    const startTime = Date.now();

    // Enhanced logging for real trades
    logTradeOperation(`Real Trade ${direction.toUpperCase()} Started`, {
      tokenAddress: params.tokenAddress,
      tokenSymbol: params.tokenSymbol,
      amount: params.amount,
      slippageBps: params.slippageBps,
      userPublicKey: params.userPublicKey,
      direction
    })

    try {
      console.log(`🔄 Raptor swap for ${direction} ${params.tokenSymbol}...`)

      const prepared = await prepareSwapTransaction({
        userPublicKey: params.userPublicKey,
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount,
        slippageBps: params.slippageBps,
        priorityFeeLamports: params.priorityFee || 0,
        direct: true,
      })

      console.log(`🔧 Raptor tx prepared, out≈${prepared.outAmount ?? '?'}`)

      const tx = VersionedTransaction.deserialize(
        Buffer.from(prepared.swapTransaction, 'base64'),
      )

      console.log(`✍️ Signing transaction...`)
      const signedTxs = await this.signer([tx])
      const signedTx = signedTxs[0]

      console.log(`📡 Submitting via Raptor...`)
      const sendResult = await submitSignedSwap({
        signedTx,
        prepared,
        connection: this.connection,
        direct: true,
      })

      const signature = sendResult.signature

      await confirmSwapSignature({
        signature,
        via: sendResult.via,
        checkViaRaptor: sendResult.checkViaRaptor,
        connection: this.connection,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        blockhash: signedTx.message.recentBlockhash,
        direct: true,
      })

      const responseTime = Date.now() - startTime

      const result = {
        success: true,
        signature,
        inputAmount: String(params.amount),
        outputAmount: prepared.outAmount ?? '0',
        fees: { totalFees: 0, feePercentage: 0.5 },
        provider: 'raptor',
        rpcUsed: sendResult.via === 'raptor' ? 'raptor' : 'rpc',
        responseTime,
      }

      logTradeOperation(`Real Trade ${direction.toUpperCase()} SUCCESS`, {
        tokenSymbol: params.tokenSymbol,
        signature,
        inputAmount: result.inputAmount,
        outputAmount: result.outputAmount,
        responseTime,
        fees: result.fees.totalFees,
      })

      return result
    } catch (error) {
      const responseTime = Date.now() - startTime

      // Enhanced error logging for real trades
      logTradeOperation(`Real Trade ${direction.toUpperCase()} FAILED`, {
        tokenSymbol: params.tokenSymbol,
        direction,
        amount: params.amount,
        slippageBps: params.slippageBps,
        responseTime,
        userPublicKey: params.userPublicKey
      }, error as Error)

      return {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'raptor',
        rpcUsed: 'raptor',
        responseTime,
        error: error instanceof Error ? error.message : 'Real trade failed'
      }
    }
  }
}

// Synchronized trade executor that runs both simulation and real trading with the same quote
export class SynchronizedTradeExecutor {
  private realExecutor?: RealTradeExecutor
  private simExecutor: SyncedSimulationExecutor

  constructor(
    connection?: Connection,
    signer?: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
  ) {
    this.simExecutor = new SyncedSimulationExecutor()
    if (connection && signer) {
      this.realExecutor = new RealTradeExecutor(connection, signer)
    }
  }

  async executeSyncedBuy(params: TradeExecutionParams, executeReal: boolean = false): Promise<SyncedTradeResult> {
    const startTime = Date.now()

    // Get shared Jupiter quote first
    console.warn(`🔄 Getting shared Jupiter quote for ${params.tokenSymbol}...`)
    const quote = await getSwapQuote(
      params.inputMint,
      params.outputMint,
      params.amount,
      params.slippageBps
    )

    if (!quote) {
      const failedResult = {
        success: false,
        inputAmount: params.amount.toString(),
        outputAmount: '0',
        fees: { totalFees: 0, feePercentage: 0 },
        provider: 'jupiter',
        rpcUsed: 'none',
        responseTime: Date.now() - startTime,
        error: 'No Jupiter quote available'
      }
      return {
        simulation: failedResult,
        quote: null
      }
    }

    console.log(`📊 Shared Jupiter quote: ${quote.inAmount} → ${quote.outAmount}`)

    // Execute simulation (always)
    const simulationResult = await this.simExecutor.executeBuy(params)

    // Execute real trade if requested and executor available
    let realResult: TradeExecutionResult | undefined
    if (executeReal && this.realExecutor) {
      console.warn(`🔥 Executing real trade with same quote...`)
      realResult = await this.realExecutor.executeBuy(params)
    }

    // Calculate deviation if both results exist
    let deviation: SyncedTradeResult['deviation']
    if (realResult && simulationResult.success && realResult.success) {
      const simOutput = parseFloat(simulationResult.outputAmount)
      const realOutput = parseFloat(realResult.outputAmount)
      const outputDiff = Math.abs(simOutput - realOutput)
      const outputDiffPercent = simOutput > 0 ? (outputDiff / simOutput) * 100 : 0

      deviation = {
        outputAmountDiff: outputDiff,
        outputAmountDiffPercent: outputDiffPercent,
        feesDiff: Math.abs(simulationResult.fees.totalFees - realResult.fees.totalFees),
        responseTimeDiff: Math.abs(simulationResult.responseTime - realResult.responseTime)
      }

      // Log significant deviations
      if (outputDiffPercent > 2) { // More than 2% difference
        logTradeOperation('Significant Trade Deviation Detected', {
          tokenSymbol: params.tokenSymbol,
          simulationOutput: simulationResult.outputAmount,
          realOutput: realResult.outputAmount,
          deviationPercent: outputDiffPercent.toFixed(2),
          simulationFees: simulationResult.fees.totalFees,
          realFees: realResult.fees.totalFees,
          quote: {
            inAmount: quote.inAmount,
            outAmount: quote.outAmount
          }
        })
      }
    }

    const syncResult = {
      simulation: simulationResult,
      real: realResult,
      quote,
      deviation
    }

    // Send Discord notification for sync results
    if (shouldEnableNotifications() && (simulationResult.success || (realResult && realResult.success))) {
      try {
        await sendSyncTradeNotificationDiscord({
          tokenSymbol: params.tokenSymbol,
          tokenAddress: params.tokenAddress,
          operationType: 'buy',
          syncResult,
          isRealTradeExecuted: executeReal && !!realResult,
          tokenData: params.tokenData
        })
      } catch (discordError) {
        console.error('❌ Failed to send sync Discord notification:', discordError)
        // Don't fail the trade if Discord notification fails
      }
    }

    return syncResult
  }
}

// Factory function to create appropriate executor
export function createTradeExecutor(
  isSimulated: boolean,
  connection?: Connection,
  signer?: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): TradeExecutor {
  if (isSimulated) {
    return new SimulationExecutor()
  } else {
    if (!connection || !signer) {
      throw new Error('Connection and signer required for real trading')
    }
    return new RealTradeExecutor(connection, signer)
  }
}

// Update the factory function to support synchronized execution
export function createSynchronizedTradeExecutor(
  connection?: Connection,
  signer?: (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]>
): SynchronizedTradeExecutor {
  return new SynchronizedTradeExecutor(connection, signer)
}

// Keypair management utilities
export function loadTradingKeypair(keypairPath?: string): Keypair {
  // Prefer env-var when running in serverless environments (e.g. Vercel)
  const envJson = process.env.TRADING_KEYPAIR_JSON
  if (envJson) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envJson)))
  }

  // Fallback to reading from file for local development / self-hosted runs
  if (keypairPath) {
    const fs = require('fs')
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
    return Keypair.fromSecretKey(Uint8Array.from(keypairData))
  }

  throw new Error('Trading keypair not provided. Set TRADING_KEYPAIR_JSON env or supply keypairPath.')
}

export function createSignerFromKeypair(keypair: Keypair): (transactions: VersionedTransaction[]) => Promise<VersionedTransaction[]> {
  return async (transactions: VersionedTransaction[]): Promise<VersionedTransaction[]> => {
    return transactions.map(tx => {
      tx.sign([keypair])
      return tx
    })
  }
}
