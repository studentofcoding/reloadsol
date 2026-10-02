import { query, queryOne } from '@/utils/db'
import { log } from '@/utils/unified-logger'
import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js'
import { getSwapQuote, fetchUserTokens, type UserToken } from '@/utils/jupiter'
import {
  prepareSwapTransaction,
  submitSignedSwap,
  confirmSwapSignature,
} from '@/utils/swap-executor'
import { notifySlTpTrigger } from './trading-notifications'
import { getConnection } from '@/utils/solana'
import { fetchShyftAllTokensCached } from '@/utils/shyft-wallet-cache'
import { mapShyftTokensToUserTokens } from '@/utils/shyft-wallet'
import { fetchJupiterPortfolioDirect, mapPortfolioToUserTokens } from '@/utils/jupiter-portfolio'
import { getOpenPositionPrices } from '@/utils/open-position-prices'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { closeSimulatedPositionFromWorker } from '@/utils/sl-tp-sim-close'
import { evaluateExit, toPersistedCloseReason } from '@/utils/exit-evaluator'

/**
 * The backstop share above which the exit system is considered broken (S5).
 *
 * `max_hold` / `max_age` firing means the primary exit did NOT fire. That should be ~0, not a
 * percentage — the default of 10 is a tripwire, not a target. Env-tunable so it can be tightened
 * without a deploy once the real distribution is known.
 */
function getExitBackstopAlertPct(): number {
    const raw = Number(process.env.EXIT_BACKSTOP_ALERT_PCT)
    return Number.isFinite(raw) && raw >= 0 ? raw : 10
}

/**
 * The age past which a live value is too old to decide on (S4).
 *
 * NOTE: deliberately NOT wired into a comparison that cannot fire. `getOpenPositionPrices` serves
 * from a Redis cache with a 5s TTL, so a `price` basis value is never older than five seconds —
 * far inside any sane bound. Reading it here keeps the key honest rather than decorative, so a
 * future slower source has one place to honour instead of a dead guard that looks like a check.
 */
export function getExitMaxInputAgeSec(): number {
    const raw = Number(process.env.EXIT_MAX_INPUT_AGE_SEC)
    return Number.isFinite(raw) && raw > 0 ? raw : 180
}

/** Cached Shyft all_tokens, then Jupiter, then RPC token accounts. */
async function fetchSlTpWalletTokens(
  walletAddress: string,
  fresh = false,
): Promise<UserToken[]> {
  try {
    const shyft = await fetchShyftAllTokensCached(walletAddress, 'mainnet-beta', {
      fresh,
    })
    return mapShyftTokensToUserTokens(shyft.tokens)
  } catch (shyftErr) {
    log.warn(
      'error_handling',
      'Shyft all_tokens unavailable for SL/TP holdings, trying Jupiter',
      { walletAddress, error: shyftErr instanceof Error ? shyftErr.message : String(shyftErr) },
    )
  }

  try {
    const portfolio = await fetchJupiterPortfolioDirect(walletAddress)
    return mapPortfolioToUserTokens(portfolio)
  } catch (jupErr) {
    log.warn(
      'error_handling',
      'Jupiter portfolio unavailable for SL/TP holdings, falling back to RPC',
      { walletAddress, error: jupErr instanceof Error ? jupErr.message : String(jupErr) },
    )
  }

  const pubkey = new PublicKey(walletAddress)
  return fetchUserTokens(getConnection(), pubkey, false, false)
}

export interface SLTPPosition {
  /** Paper position: tracked, never executed on-chain (see isSimulatedPosition). */
  is_simulation?: boolean | null
    /** The exit contract (S8). NULL on rows written before it existed — they read as 'price'. */
    reference_kind?: 'price' | 'mcap' | null
    reference_value?: number | null
    exit_basis?: 'price' | 'mcap' | null
    chain?: string | null
    id: string
    wallet_address: string
    token_address: string
    token_symbol: string
    position_size: number
    entry_price: number
    current_price: number
    stop_loss_price: number
    take_profit_price: number
    stop_loss_percentage: number
    take_profit_percentage: number
    position_type: 'manual' | 'bot'
    strategy_id?: string
    created_at: string
    updated_at: string
    is_active: boolean
    /**
     * Why it closed (S2/S5), and when. NOT derivable from the `*_executed` flags below: those say
     * which trigger fired, and a `max_age` / `max_hold` backstop used to be filed as `tp1_executed`.
     * NULL on rows closed before migration 58.
     */
    close_reason?: string | null
    closed_at?: string | null
    /**
     * Force-close after this many hours (S5). NULL means no backstop is configured, which is a
     * position that can stay open indefinitely. Stamped at open from the strategy's effective exit;
     * before 59-sl-tp-max-hold.sql it was accepted by the type and then dropped, so no position
     * could time out at all.
     */
    max_hold_hours?: number | null
    // TP levels for bot positions
    tp1_percentage?: number
    tp1_sell_percentage?: number
    tp2_percentage?: number
    tp3_percentage?: number
    tp3_enabled?: boolean
    // Execution tracking
    tp1_executed?: boolean
    tp2_executed?: boolean
    tp3_executed?: boolean
    sl_executed?: boolean
}

export interface SLTPTriggerResult {
    triggered: boolean
    // `max_age` is separate from `max_hold_time`: two backstops that reported the same trigger could
    // not be told apart in the row, which is what made S5's backstop share uncomputable.
    trigger_type: 'stop_loss' | 'take_profit_1' | 'take_profit_2' | 'take_profit_3' | 'max_hold_time' | 'max_age' | 'label_rugged'
    sell_percentage: number
    current_price: number
    trigger_price: number
    gain_percentage: number
    reason: string
}

// ✅ NEW: Interface for open position from PnLTracker logic
interface OpenPositionCycle {
    mintAddress: string
    symbol?: string
    name?: string
    logoURI?: string
    totalSolBought: number
    totalTokenBought: number
    remainingTokenAmount: number
    weightedBuyPriceUsd: number
    firstBuyTimestamp: number
    buySignatures: string[]
    isBotOperation: boolean
    botStrategy?: string
}

// Cache for position data to avoid frequent database calls
const positionCache = new Map<string, SLTPPosition>()
const CACHE_TTL_MS = 30 * 1000 // 30 seconds cache for faster response

// ✅ NEW: Threshold to determine zero/closed balance
const ZERO_BALANCE_THRESHOLD = 0.000001

// Trading connection (will be initialized when needed)
let tradingConnection: Connection | null = null
let tradingKeypair: Keypair | null = null

// Initialize trading connection
async function initializeTradingConnection(): Promise<void> {
    if (tradingConnection && tradingKeypair) return

    try {
        // Use the existing connection from solana utils
        tradingConnection = getConnection()

        const keypairJson = process.env.TRADING_KEYPAIR_JSON
        if (keypairJson) {
            const secretKey = JSON.parse(keypairJson)
            tradingKeypair = Keypair.fromSecretKey(new Uint8Array(secretKey))
            log.info('price_tracking', 'Trading connection initialized for real trading')
        } else {
            log.info('price_tracking', 'No trading keypair found, simulation mode only')
        }
    } catch (error) {
        log.error('error_handling', 'Failed to initialize trading connection', error as Error)
    }
}

// ✅ NEW: Function to get existing open positions using PnLTracker logic
async function getExistingOpenPositions(walletAddress: string): Promise<OpenPositionCycle[]> {
    try {
        // Get trading records from the API (works on server and client)
        const baseUrl = process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || 'http://localhost:3000'
        const apiUrl = `${baseUrl}/api/trading/records?wallet=${encodeURIComponent(walletAddress)}`

        log.info('price_tracking', 'Fetching trading records for open positions', {
            walletAddress: walletAddress.substring(0, 8) + '...',
            apiUrl: apiUrl.replace(walletAddress, walletAddress.substring(0, 8) + '...')
        })

        const response = await fetch(apiUrl)
        if (!response.ok) {
            throw new Error(`Failed to fetch trading records: ${response.statusText}`)
        }

        const { records } = await response.json()

        // Apply the same logic as PnLTracker to identify open positions
        const buyRecords = records.filter((record: any) =>
            record.operationType === 'buy' && record.successCount > 0
        )

        const allSellRecords = records.filter((record: any) =>
            record.operationType === 'sell' && record.successCount > 0
        )

        // Process sell records with sell+close combination logic (same as PnLTracker)
        const processedSellRecords: any[] = []
        const processedRecordIds = new Set<string>()

        allSellRecords.forEach((sellRecord: any) => {
            if (processedRecordIds.has(sellRecord.id)) return

            const closeRecord = records.find((r: any) =>
                r.operationType === 'close' &&
                r.successCount > 0 &&
                !processedRecordIds.has(r.id) &&
                Math.abs(r.timestamp - sellRecord.timestamp) <= 30000
            )

            if (closeRecord) {
                const combinedRecord = {
                    ...sellRecord,
                    tokens: [...sellRecord.tokens, ...closeRecord.tokens].filter((token: any, index: number, self: any[]) =>
                        index === self.findIndex(t => t.mintAddress === token.mintAddress)
                    ),
                    successCount: sellRecord.successCount + closeRecord.successCount,
                    totalTokens: sellRecord.totalTokens + closeRecord.totalTokens,
                    signatures: [...sellRecord.signatures, ...closeRecord.signatures],
                    is_bot_operation: sellRecord.is_bot_operation || closeRecord.is_bot_operation,
                    bot_strategy: sellRecord.bot_strategy || closeRecord.bot_strategy,
                }

                processedSellRecords.push(combinedRecord)
                processedRecordIds.add(sellRecord.id)
                processedRecordIds.add(closeRecord.id)
            } else {
                processedSellRecords.push(sellRecord)
                processedRecordIds.add(sellRecord.id)
            }
        })

        // Build cycles using the same logic as PnLTracker
        const allOpsUnsorted = [...buyRecords, ...processedSellRecords]
        allOpsUnsorted.sort((a, b) => a.timestamp - b.timestamp)

        const openCycles = new Map<string, OpenPositionCycle>()

        for (const op of allOpsUnsorted) {
            const isBuy = op.operationType === 'buy'
            const tokensInOp = op.tokens || []

            if (!op.solAmount || op.successCount === 0) continue

            const solPerToken = op.solAmount / op.successCount

            for (const tkn of tokensInOp) {
                const mint = tkn.mintAddress
                if (!mint) continue

                if (isBuy) {
                    let cycle = openCycles.get(mint)
                    if (!cycle) {
                        cycle = {
                            mintAddress: mint,
                            symbol: tkn.symbol,
                            name: tkn.name,
                            logoURI: tkn.logoURI,
                            totalSolBought: 0,
                            totalTokenBought: 0,
                            remainingTokenAmount: 0,
                            weightedBuyPriceUsd: 0,
                            firstBuyTimestamp: op.timestamp,
                            buySignatures: [],
                            isBotOperation: !!op.is_bot_operation,
                            botStrategy: op.bot_strategy,
                        }
                        openCycles.set(mint, cycle)
                    }

                    const tokenAmt = tkn.tokenAmount || 0
                    cycle.totalSolBought += solPerToken
                    cycle.totalTokenBought += tokenAmt
                    cycle.remainingTokenAmount += tokenAmt
                    if (tkn.priceUsd) {
                        const buyCount = cycle.buySignatures.length / op.signatures.length || 1
                        cycle.weightedBuyPriceUsd =
                            (cycle.weightedBuyPriceUsd * buyCount + tkn.priceUsd) / (buyCount + 1)
                    }
                    cycle.buySignatures.push(...op.signatures)

                    if (op.is_bot_operation) {
                        cycle.isBotOperation = true
                        cycle.botStrategy = op.bot_strategy || cycle.botStrategy
                    }
                } else {
                    // SELL branch
                    const cycle = openCycles.get(mint)
                    if (!cycle) continue

                    const tokenAmt = tkn.tokenAmount || 0
                    cycle.remainingTokenAmount = Math.max(0, cycle.remainingTokenAmount - tokenAmt)

                    if (op.is_bot_operation) {
                        cycle.isBotOperation = true
                        cycle.botStrategy = op.bot_strategy || cycle.botStrategy
                    }

                    // If cycle is fully closed, remove it
                    if (cycle.remainingTokenAmount <= 1e-6) {
                        openCycles.delete(mint)
                    }
                }
            }
        }

        // Verify open positions against wallet holdings
        const openPositions: OpenPositionCycle[] = []
        if (openCycles.size > 0) {
            try {
                const walletTokens = await fetchSlTpWalletTokens(walletAddress)

                openCycles.forEach((cycle) => {
                    const walletTok = walletTokens.find((wt) => wt.mintAddress === cycle.mintAddress)
                    if (walletTok && walletTok.uiAmount > 0.001) {
                        openPositions.push({
                            ...cycle,
                            symbol: cycle.symbol || walletTok.symbol,
                            name: cycle.name || walletTok.name,
                            logoURI: cycle.logoURI || walletTok.logoURI,
                        })
                    }
                })
            } catch (walletErr) {
                log.error('error_handling', 'Failed fetching wallet tokens for open position verification', walletErr as Error)
            }
        }

        return openPositions

    } catch (error) {
        log.error('error_handling', 'Failed to get existing open positions', error as Error, { walletAddress })
        return []
    }
}

// ✅ NEW: Function to sync existing open positions to SL/TP tracker
export async function syncExistingOpenPositions(walletAddress: string, options?: {
    defaultStopLossPercentage?: number
    defaultTakeProfitPercentage?: number
    botTp1Percentage?: number
    botTp1SellPercentage?: number
    botTp2Percentage?: number
    botTp3Percentage?: number
    botTp3Enabled?: boolean
}): Promise<{ synced: number; skipped: number; errors: number }> {
    try {
        const {
            defaultStopLossPercentage = -20, // Default 20% stop loss
            defaultTakeProfitPercentage = 50, // Default 50% take profit
            botTp1Percentage = 30,
            botTp1SellPercentage = 80,
            botTp2Percentage = 100,
            botTp3Percentage = 20, // Trailing stop at 20%
            botTp3Enabled = true
        } = options || {}

        log.info('price_tracking', 'Starting sync of existing open positions', { walletAddress })

        // Get existing open positions using PnLTracker logic
        const openPositions = await getExistingOpenPositions(walletAddress)

        if (openPositions.length === 0) {
            log.info('price_tracking', 'No existing open positions found to sync', { walletAddress })
            return { synced: 0, skipped: 0, errors: 0 }
        }

        // Check which positions already exist in SL/TP tracker
        const { rows: existingPositions } = await query<{ token_address: string }>(
            `SELECT token_address FROM sl_tp_positions
             WHERE wallet_address = $1 AND is_active = true`,
            [walletAddress],
        )

        const existingTokens = new Set(existingPositions.map(p => p.token_address))

        let synced = 0
        let skipped = 0
        let errors = 0

        // Add SL/TP positions for tokens that don't already have them
        for (const position of openPositions) {
            try {
                if (existingTokens.has(position.mintAddress)) {
                    log.debug('price_tracking', 'Position already has SL/TP tracking, skipping', {
                        tokenAddress: position.mintAddress,
                        symbol: position.symbol
                    })
                    skipped++
                    continue
                }

                // Determine position type and parameters
                const positionType = position.isBotOperation ? 'bot' : 'manual'
                const stopLossPercentage = defaultStopLossPercentage
                const takeProfitPercentage = defaultTakeProfitPercentage

                // Add the position to SL/TP tracker
                await addSLTPPosition({
                    walletAddress,
                    tokenAddress: position.mintAddress,
                    tokenSymbol: position.symbol || 'Unknown',
                    positionSize: position.totalTokenBought,
                    entryPrice: position.weightedBuyPriceUsd || 0,
                    stopLossPercentage,
                    takeProfitPercentage,
                    positionType,
                    strategyId: position.botStrategy,
                    // Bot-specific parameters
                    tp1Percentage: positionType === 'bot' ? botTp1Percentage : undefined,
                    tp1SellPercentage: positionType === 'bot' ? botTp1SellPercentage : undefined,
                    tp2Percentage: positionType === 'bot' ? botTp2Percentage : undefined,
                    tp3Percentage: positionType === 'bot' ? botTp3Percentage : undefined,
                    tp3Enabled: positionType === 'bot' ? botTp3Enabled : undefined,
                })

                log.info('price_tracking', 'Synced existing position to SL/TP tracker', {
                    tokenAddress: position.mintAddress,
                    symbol: position.symbol,
                    positionType,
                    stopLossPercentage,
                    takeProfitPercentage
                })

                synced++

            } catch (error) {
                log.error('error_handling', 'Failed to sync position to SL/TP tracker', error as Error, {
                    tokenAddress: position.mintAddress,
                    symbol: position.symbol
                })
                errors++
            }
        }

        log.info('price_tracking', 'Completed sync of existing open positions', {
            walletAddress,
            totalPositions: openPositions.length,
            synced,
            skipped,
            errors
        })

        return { synced, skipped, errors }

    } catch (error) {
        log.error('error_handling', 'Failed to sync existing open positions', error as Error, { walletAddress })
        throw error
    }
}

// Function to add a new SL/TP position
/**
 * THE invariant that keeps a paper stop-loss from spending real money.
 *
 * `executeSellOrder` runs a REAL swap — it hardcodes isSimulated: false — so every path that could
 * reach it must first ask this. A simulated position is evaluated and recorded, never executed
 * on-chain, and never balance-reconciled either: paper tokens do not exist on-chain, so the wallet
 * lookup reads zero and reconciliation would prune the position on its first pass.
 */
export function isSimulatedPosition(position: { is_simulation?: boolean | null } | null | undefined): boolean {
  return position?.is_simulation === true
}

export async function addSLTPPosition(params: {
    walletAddress: string
    tokenAddress: string
    tokenSymbol: string
    positionSize: number
    entryPrice: number
    stopLossPercentage: number
    takeProfitPercentage: number
    positionType: 'manual' | 'bot'
    strategyId?: string
    /** Paper position: tracked and triggered, never executed on-chain. */
    isSimulation?: boolean
    /**
     * The exit contract (S8). `referenceKind` says what `referenceValue` is, `exitBasis` says what
     * the thresholds are expressed in. Both default to 'price' with `referenceValue = entryPrice`,
     * so a caller that predates the contract writes exactly what it wrote before.
     */
    referenceKind?: 'price' | 'mcap'
    referenceValue?: number
    exitBasis?: 'price' | 'mcap'
    /** The chain the position is on. The worker prices Sim burns and Robinhood differently. */
    chain?: string
    /**
     * The max-hold backstop (S5), in hours. Carried here because the worker reads it off the row; a
     * position opened without one has no backstop and can stay open indefinitely, which is why the
     * exit contract stamps it rather than leaving it to a caller to remember.
     */
    maxHoldHours?: number
    // Bot-specific TP levels
    tp1Percentage?: number
    tp1SellPercentage?: number
    tp2Percentage?: number
    tp3Percentage?: number
    tp3Enabled?: boolean
}): Promise<string> {
    try {
        const {
            walletAddress,
            tokenAddress,
            tokenSymbol,
            positionSize,
            entryPrice,
            stopLossPercentage,
            takeProfitPercentage,
            positionType,
            strategyId,
            referenceKind,
            referenceValue,
            exitBasis,
            chain,
            maxHoldHours,
            tp1Percentage,
            tp1SellPercentage,
            tp2Percentage,
            tp3Percentage,
            tp3Enabled
        } = params

        const stopLossPrice = entryPrice * (1 + stopLossPercentage / 100)
        const takeProfitPrice = entryPrice * (1 + takeProfitPercentage / 100)

        const position: Omit<SLTPPosition, 'id'> = {
            wallet_address: walletAddress,
            token_address: tokenAddress,
            token_symbol: tokenSymbol,
            position_size: positionSize,
            entry_price: entryPrice,
            current_price: entryPrice,
            stop_loss_price: stopLossPrice,
            take_profit_price: takeProfitPrice,
            stop_loss_percentage: stopLossPercentage,
            take_profit_percentage: takeProfitPercentage,
            position_type: positionType,
            strategy_id: strategyId,
            reference_kind: referenceKind ?? 'price',
            reference_value: referenceValue ?? entryPrice,
            exit_basis: exitBasis ?? 'price',
            chain: chain ?? 'sol',
            max_hold_hours: maxHoldHours ?? null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_active: true,
            // Bot-specific fields
            tp1_percentage: tp1Percentage,
            tp1_sell_percentage: tp1SellPercentage,
            tp2_percentage: tp2Percentage,
            tp3_percentage: tp3Percentage,
            tp3_enabled: tp3Enabled,
            tp1_executed: false,
            tp2_executed: false,
            tp3_executed: false,
            sl_executed: false
        }

        const row = await queryOne<{ id: string }>(
            `INSERT INTO sl_tp_positions (
               wallet_address, token_address, token_symbol, position_size,
               entry_price, current_price, stop_loss_price, take_profit_price,
               stop_loss_percentage, take_profit_percentage, position_type,
               strategy_id, created_at, updated_at, is_active,
               tp1_percentage, tp1_sell_percentage, tp2_percentage,
               tp3_percentage, tp3_enabled,
               tp1_executed, tp2_executed, tp3_executed, sl_executed,
               is_simulation,
               reference_kind, reference_value, exit_basis, chain, max_hold_hours
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
             ) RETURNING id`,
            [
                position.wallet_address,
                position.token_address,
                position.token_symbol,
                position.position_size,
                position.entry_price,
                position.current_price,
                position.stop_loss_price,
                position.take_profit_price,
                position.stop_loss_percentage,
                position.take_profit_percentage,
                position.position_type,
                position.strategy_id ?? null,
                position.created_at,
                position.updated_at,
                position.is_active,
                position.tp1_percentage ?? null,
                position.tp1_sell_percentage ?? null,
                position.tp2_percentage ?? null,
                position.tp3_percentage ?? null,
                position.tp3_enabled ?? null,
                position.tp1_executed ?? false,
                position.tp2_executed ?? false,
                position.tp3_executed ?? false,
                position.sl_executed ?? false,
                params.isSimulation ?? false,
                position.reference_kind ?? 'price',
                position.reference_value ?? position.entry_price,
                position.exit_basis ?? 'price',
                position.chain ?? 'sol',
                position.max_hold_hours ?? null,
            ],
        )

        if (!row) throw new Error('Insert failed')

        const fullPosition = { ...position, id: row.id }
        positionCache.set(`${walletAddress}_${tokenAddress}`, fullPosition)

        log.info('price_tracking', 'SL/TP position added', {
            positionId: row.id,
            tokenSymbol,
            positionType,
            stopLossPercentage,
            takeProfitPercentage
        })

        return row.id

    } catch (error) {
        log.error('error_handling', 'Failed to add SL/TP position', error as Error, { params })
        throw error
    }
}

// Function to get current token prices
/**
 * Prices for a set of positions, grouped by the chain each row declares.
 *
 * This used to pass a hardcoded 'sol' for every row ("sl_tp_positions is Solana live-only"), which
 * was true when only the mcap family registered. A Robinhood row priced through the Solana path
 * returns a number that is not its price — and the exit would then be evaluated against it. The
 * chain is read off the row (S8's `chain`, defaulting to 'sol' for every pre-existing row).
 */
async function getCurrentTokenPrices(
    positions: Array<{ token_address: string; chain?: string | null }>,
): Promise<Map<string, number>> {
    try {
        const byChain = new Map<string, string[]>()
        for (const position of positions) {
            const chain = position.chain === 'robinhood' ? 'robinhood' : 'sol'
            const mints = byChain.get(chain) ?? []
            mints.push(position.token_address)
            byChain.set(chain, mints)
        }

        const priceMap = new Map<string, number>()
        for (const [chain, mints] of Array.from(byChain.entries())) {
            const prices = await getOpenPositionPrices(mints, chain as GmgnTradeChain)
            for (const [address, price] of Object.entries(prices)) {
                if (typeof price === 'number' && price > 0) {
                    priceMap.set(address, price)
                }
            }
        }

        return priceMap
    } catch (error) {
        log.error('price_tracking', 'Failed to fetch token prices', error as Error)
        return new Map()
    }
}

/**
 * Persist the pass's prices in ONE statement.
 *
 * This was one `UPDATE ... WHERE id = $1` per position, issued inside the trigger map, so a pass
 * with ~160 open positions fired ~160 concurrent queries at the pool. Measured against a
 * 25-client pool: `total=25 idle=0 waiting=4…9` with 273 acquire failures in five minutes, and
 * `/api/strategies/outcomes` failing at the 5s timeout because it queued behind them. Every
 * waiter was one of these writes. One statement is one round-trip and removes the burst.
 */
async function persistCurrentPrices(
    positions: Array<{ id: string; token_address: string }>,
    prices: Map<string, number>,
): Promise<void> {
    const ids: string[] = []
    const values: number[] = []
    for (const position of positions) {
        const price = prices.get(position.token_address)
        if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
            ids.push(position.id)
            values.push(price)
        }
    }
    if (ids.length === 0) return
    const ts = new Date().toISOString()
    await query(
        `UPDATE sl_tp_positions AS p
            SET current_price = v.price, updated_at = v.ts
           FROM unnest($1::uuid[], $2::numeric[], $3::timestamptz[]) AS v(id, price, ts)
          WHERE p.id = v.id`,
        [ids, values, ids.map(() => ts)],
    )
}

// Function to check SL/TP triggers for a position
// Exported for its own test: it is the row -> decision adapter, and the one place a row's fields are
// translated into the evaluator's inputs.
export function checkSLTPTriggers(
    position: SLTPPosition,
    currentPrice: number,
    opts: { stale?: boolean; rugged?: boolean } = {},
): SLTPTriggerResult {
    // The decision itself lives in `evaluateExit` (S2), so the worker, the sims and the live path
    // all resolve a trigger the same way. This function is the row -> decision adapter.
    const isStop = position.sl_executed === true
    const decision = evaluateExit({
        // Pre-contract rows have no reference_value; their entry price is the same thing.
        referenceValue: position.reference_value ?? position.entry_price,
        referenceKind: position.reference_kind,
        live: currentPrice,
        stopLossPct: isStop ? null : position.stop_loss_percentage,
        takeProfitPct: position.take_profit_percentage,
        ladder: {
            tp1Pct: position.tp1_percentage,
            tp1SellPct: position.tp1_sell_percentage,
            tp2Pct: position.tp2_percentage,
            tp3Pct: position.tp3_percentage,
            tp3Enabled: position.tp3_enabled,
            tp1Executed: position.tp1_executed,
            tp2Executed: position.tp2_executed,
            tp3Executed: position.tp3_executed,
        },
        entryAt: position.created_at,
        // The backstop, read off the row. It was never passed before, so `max_hold` / `max_age`
        // could not fire and a position that never crossed its stop or target stayed open forever.
        maxHoldHours: position.max_hold_hours,
        // Both resolved by the caller: this stays a pure adapter. `stale` is what turns an
        // unevaluable position into a REPORTED one rather than a silent skip (S4); `rugged` closes
        // a known rug regardless of where the price sits.
        stale: opts.stale,
        rugged: opts.rugged,
        // NOTE: `maxAgeHours` is still not passed, and there is no column or config for it — so
        // `max_age` remains unreachable while `max_hold` now fires. The two were interchangeable
        // before (`max_age` was the mcap family's version of the same idea), so one live backstop is
        // the honest state rather than two flags where only one can ever be set.
    })

    const gainPercentage = decision.pnlPct ?? 0
    const pctForPrice =
        decision.triggerType === 'take_profit_1'
            ? (position.tp1_percentage ?? position.take_profit_percentage)
            : decision.triggerType === 'take_profit_2'
              ? position.tp2_percentage
              : decision.triggerType === 'take_profit_3'
                ? position.tp3_percentage
                : null

    return {
        triggered: decision.close,
        // The shape predates the decision function and always names a type; keep its contract.
        trigger_type: decision.triggerType ?? 'stop_loss',
        sell_percentage: decision.sellPercentage,
        current_price: currentPrice,
        trigger_price:
            decision.triggerType === 'stop_loss'
                ? position.stop_loss_price
                : pctForPrice != null
                  ? position.entry_price * (1 + pctForPrice / 100)
                  : 0,
        gain_percentage: gainPercentage,
        reason: decision.close
            ? `${decision.triggerType} triggered at ${gainPercentage.toFixed(2)}% (${decision.basisUsed} basis)`
            : decision.reason === 'stale'
              ? 'No triggers met (stale input)'
              : 'No triggers met',
    }
}

/** The triggers that need only a clock or a rug label, never a live price. */
const UNPRICED_BACKSTOP_TRIGGERS = new Set<SLTPTriggerResult['trigger_type']>([
    'label_rugged',
    'max_hold_time',
    'max_age',
])

/**
 * Exit decision for a position with NO readable price this pass.
 *
 * A live price is what stop-loss and take-profit are measured against, so those must never fire from
 * a stale number. `maxHoldHours` and a rug label are different: they are true regardless of price and
 * only need *a* price to book the close at. That price is the last one persisted on the row
 * (`current_price`, refreshed every priced pass). Returns the close to take, or `null` when nothing
 * backstop-level fires or the row has never held a usable price (it then stays reported STALE).
 */
export function resolveUnpricedBackstop(
    position: SLTPPosition,
    rugged: boolean,
): SLTPTriggerResult | null {
    const last = position.current_price
    if (!(typeof last === 'number' && Number.isFinite(last) && last > 0)) return null
    // Thresholds off: with the last price already past a stop/target, SL/TP would shadow the
    // backstop (evaluateExit checks them first) and a due max-hold would stay open.
    const backstopOnly = {
        ...position,
        stop_loss_percentage: null,
        take_profit_percentage: null,
        tp1_percentage: null,
        tp2_percentage: null,
        tp3_percentage: null,
    } as unknown as SLTPPosition
    const result = checkSLTPTriggers(backstopOnly, last, { rugged })
    if (!result.triggered || !UNPRICED_BACKSTOP_TRIGGERS.has(result.trigger_type)) return null
    return {
        ...result,
        reason: `${result.reason} [unpriced: closed on last known price]`,
    }
}

// ✅ NEW: Build wallet token map for quick lookups
async function getWalletTokenMap(walletAddress: string): Promise<Map<string, { uiAmount: number; decimals: number }>> {
    try {
        const tokens = await fetchSlTpWalletTokens(walletAddress)
        const map = new Map<string, { uiAmount: number; decimals: number }>()
        for (const t of tokens) {
            map.set(t.mintAddress, { uiAmount: t.uiAmount, decimals: t.decimals })
        }
        return map
    } catch (e) {
        log.error('error_handling', 'Failed building wallet token map', e as Error, { walletAddress })
        return new Map()
    }
}

// ✅ NEW: Reconcile active positions with actual wallet balances; deactivate if closed manually
async function reconcileClosedPositions(positions: SLTPPosition[]): Promise<{ filteredPositions: SLTPPosition[]; pruned: number }> {
    if (!positions || positions.length === 0) return { filteredPositions: [], pruned: 0 }

    // Group by wallet
    const byWallet = new Map<string, SLTPPosition[]>()
    for (const p of positions) {
        if (!byWallet.has(p.wallet_address)) byWallet.set(p.wallet_address, [])
        byWallet.get(p.wallet_address)!.push(p)
    }

    let pruned = 0
    const keep: SLTPPosition[] = []

    for (const [wallet, walletPositions] of Array.from(byWallet.entries())) {
        const tokenMap = await getWalletTokenMap(wallet)

        for (const pos of walletPositions) {
            if (isSimulatedPosition(pos)) {
                // Paper tokens are not on-chain: the balance reads zero and this would prune the
                // position immediately. Keep it; the sims close their own positions.
                keep.push(pos)
                continue
            }
            const tokenInfo = tokenMap.get(pos.token_address)
            const hasBalance = tokenInfo && tokenInfo.uiAmount > ZERO_BALANCE_THRESHOLD

            if (!hasBalance) {
                // Mark inactive in DB
                try {
                    await query(
                        `UPDATE sl_tp_positions
                         SET is_active = false, updated_at = $2,
                             close_reason = 'reconciled', closed_at = $2
                         WHERE id = $1`,
                        [pos.id, new Date().toISOString()],
                    )

                    // Remove from cache
                    for (const [key, cached] of Array.from(positionCache.entries())) {
                        if (cached.id === pos.id) {
                            positionCache.delete(key)
                            break
                        }
                    }

                    log.info('price_tracking', 'Deactivated SL/TP position due to zero balance (manual close detected)', {
                        positionId: pos.id,
                        wallet: wallet.substring(0, 8) + '...',
                        token: pos.token_symbol,
                    })
                } catch (e) {
                    log.error('error_handling', 'Failed deactivating closed position', e as Error, { positionId: pos.id })
                }
                pruned += 1
            } else {
                keep.push(pos)
            }
        }
    }

    return { filteredPositions: keep, pruned }
}

// Function to execute sell order
/** Force 100% live close when a strategy is deactivated. */
export async function forceCloseSLTPPositionForDeactivate(
  position: SLTPPosition,
): Promise<boolean> {
  const price =
    position.current_price > 0 ? position.current_price : position.entry_price
  return executeSellOrder(position, {
    triggered: true,
    trigger_type: 'stop_loss',
    sell_percentage: 100,
    current_price: price,
    trigger_price: price,
    gain_percentage: 0,
    reason: 'strategy_deactivated',
  })
}

/** Marks a simulated position closed on trigger. Deliberately DB-only: no chain, no wallet. */
async function markSimulatedPositionClosed(
  position: SLTPPosition,
  triggerResult: SLTPTriggerResult,
): Promise<void> {
  try {
    // `tp1_executed` is set only by an actual TP1. It used to be set by EVERY non-stop trigger, so a
    // `max_age` / `max_hold` backstop was filed under take-profit — which inflated the TP count by
    // exactly the closes that are not take-profits, and made S5's backstop share uncomputable.
    const isStop = triggerResult.trigger_type === 'stop_loss'
    const isTp1 = triggerResult.trigger_type === 'take_profit_1'
    const { closeReasonForTrigger } = await import('@/strategies/close-strategy-sim-position')
    const now = new Date().toISOString()
    await query(
      `UPDATE sl_tp_positions SET
         is_active = false,
         sl_executed = CASE WHEN $2 THEN true ELSE sl_executed END,
         tp1_executed = CASE WHEN $3 THEN true ELSE tp1_executed END,
         close_reason = $4,
         closed_at = $5,
         updated_at = $5
       WHERE id = $1`,
      [
        position.id,
        isStop,
        isTp1,
        toPersistedCloseReason(closeReasonForTrigger(triggerResult.trigger_type)),
        now,
      ],
    )
  } catch (error) {
    log.error('price_tracking', 'Failed to close simulated SL/TP position', error as Error, {
      positionId: position.id,
    })
  }
}

async function executeSellOrder(position: SLTPPosition, triggerResult: SLTPTriggerResult): Promise<boolean> {
    try {
        await initializeTradingConnection()

        if (!tradingConnection || !tradingKeypair) {
            log.warn('sell_execution', 'No trading connection available, skipping execution', {
                positionId: position.id,
                tokenSymbol: position.token_symbol
            })
            return false
        }

        // ✅ Determine actual available token balance and decimals from wallet
        let decimals = 6
        let walletUiAmount = 0
        try {
            const walletTokens = await fetchSlTpWalletTokens(position.wallet_address, true)
            const t = walletTokens.find(tok => tok.mintAddress === position.token_address)
            if (t) {
                decimals = t.decimals
                walletUiAmount = t.uiAmount
            }
        } catch (e) {
            log.error('sell_execution', 'Failed fetching wallet tokens for sell execution', e as Error, {
                positionId: position.id,
                token: position.token_symbol
            })
        }

        // If no balance remains, deactivate and stop
        if (walletUiAmount <= ZERO_BALANCE_THRESHOLD) {
            await query(
                `UPDATE sl_tp_positions
                 SET is_active = false, updated_at = $2, current_price = $3,
                     close_reason = 'no_balance', closed_at = $2
                 WHERE id = $1`,
                [position.id, new Date().toISOString(), triggerResult.current_price],
            )

            log.info('sell_execution', 'No wallet balance left; deactivating position without executing swap', {
                positionId: position.id,
                tokenSymbol: position.token_symbol
            })
            return true
        }

        // Calculate token amount to sell from ACTUAL wallet balance
        const sellAmountTokens = (walletUiAmount * triggerResult.sell_percentage) / 100
        const multiplier = Math.pow(10, decimals)
        const amountInUnits = Math.floor(sellAmountTokens * multiplier)

        if (amountInUnits <= 0) {
            log.warn('sell_execution', 'Computed sell amount is zero in units; deactivating position', {
                positionId: position.id,
                tokenSymbol: position.token_symbol,
                walletUiAmount,
                sellPercentage: triggerResult.sell_percentage
            })
            await query(
                `UPDATE sl_tp_positions
                 SET is_active = false, updated_at = $2, current_price = $3,
                     close_reason = 'no_balance', closed_at = $2
                 WHERE id = $1`,
                [position.id, new Date().toISOString(), triggerResult.current_price],
            )
            return true
        }

        log.info('sell_execution', 'Executing sell order', {
            positionId: position.id,
            tokenSymbol: position.token_symbol,
            triggerType: triggerResult.trigger_type,
            sellPercentage: triggerResult.sell_percentage,
            sellAmountTokens: sellAmountTokens,
            amountInUnits,
            decimals,
            currentPrice: triggerResult.current_price
        })

        // Get swap quote
        const quoteResult = await getSwapQuote(
            position.token_address,
            'So11111111111111111111111111111111111111112', // SOL
            amountInUnits, // Use real token decimals
            300 // 3% slippage
        )

        if (!quoteResult) {
            throw new Error('Quote failed: No quote returned')
        }

        // Execute swap via Raptor
        const prepared = await prepareSwapTransaction({
            userPublicKey: tradingKeypair.publicKey.toBase58(),
            inputMint: position.token_address,
            outputMint: 'So11111111111111111111111111111111111111112',
            amount: amountInUnits,
            slippageBps: 300,
            priorityFeeLamports: 1000000,
            direct: true,
        })

        const swapTransactionBuf = Buffer.from(prepared.swapTransaction, 'base64')
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf)
        transaction.sign([tradingKeypair])

        const sendResult = await submitSignedSwap({
            signedTx: transaction,
            prepared,
            connection: tradingConnection,
            direct: true,
        })

        const signature = sendResult.signature

        await confirmSwapSignature({
          signature,
          via: sendResult.via,
          checkViaRaptor: sendResult.checkViaRaptor,
          connection: tradingConnection,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
          blockhash: transaction.message.recentBlockhash,
          direct: true,
        })

        // Update position in database
        const updateData: any = {
            updated_at: new Date().toISOString(),
            current_price: triggerResult.current_price
        }

        // Mark appropriate trigger as executed
        switch (triggerResult.trigger_type) {
            case 'stop_loss':
                updateData.sl_executed = true
                updateData.is_active = false
                break
            case 'take_profit_1':
                updateData.tp1_executed = true
                if (triggerResult.sell_percentage === 100) {
                    updateData.is_active = false
                }
                break
            case 'take_profit_2':
                updateData.tp2_executed = true
                updateData.is_active = false
                break
            case 'take_profit_3':
                updateData.tp3_executed = true
                updateData.is_active = false
                break
            // These three close the position but are deliberately NOT filed under a ladder flag.
            // The flags say WHICH trigger fired, and a rug or a backstop is not a take-profit — the
            // old code marked every non-stop close as `tp1_executed`, which is exactly how a
            // backstop ended up in the take-profit bucket. `close_reason` carries why; the flags
            // stay honest about what.
            case 'label_rugged':
            case 'max_age':
            case 'max_hold_time':
                updateData.is_active = false
                break
        }

        // The reason, decided before the UPDATE so the row carries it in the same statement as the
        // flags. `close_reason` is the only place a backstop is distinguishable from a stop-loss:
        // the boolean flags say WHICH trigger fired, never whether it was the last resort.
        const { closeReasonForTrigger: reasonForTrigger } = await import(
            '@/strategies/close-strategy-sim-position'
        )
        const persistedReason = toPersistedCloseReason(
            // A deactivation force-close arrives as a nominal `stop_loss` trigger, so reading the
            // trigger alone would file it as a stop the market never hit.
            triggerResult.reason === 'strategy_deactivated'
                ? 'strategy_deactivated'
                : reasonForTrigger(triggerResult.trigger_type),
        )
        const isFullClose = updateData.is_active === false
        const nowIso = updateData.updated_at as string

        await query(
            `UPDATE sl_tp_positions SET
               updated_at = $2,
               current_price = $3,
               sl_executed = COALESCE($4, sl_executed),
               tp1_executed = COALESCE($5, tp1_executed),
               tp2_executed = COALESCE($6, tp2_executed),
               tp3_executed = COALESCE($7, tp3_executed),
               is_active = COALESCE($8, is_active),
               close_reason = CASE WHEN $9 THEN $10 ELSE close_reason END,
               closed_at = CASE WHEN $9 THEN $11::timestamptz ELSE closed_at END
             WHERE id = $1`,
            [
                position.id,
                updateData.updated_at,
                updateData.current_price,
                updateData.sl_executed ?? null,
                updateData.tp1_executed ?? null,
                updateData.tp2_executed ?? null,
                updateData.tp3_executed ?? null,
                updateData.is_active ?? null,
                isFullClose,
                persistedReason,
                nowIso,
            ],
        )

        // Send notification
        try {
            await notifySlTpTrigger(
                position.wallet_address,
                position.token_symbol,
                triggerResult.trigger_type,
                triggerResult.gain_percentage,
                triggerResult.sell_percentage,
                signature
            )
        } catch (notifyError) {
            log.error('discord_notification', 'Failed to send notification', notifyError as Error)
        }

        log.info('sell_execution', 'Sell order executed successfully', {
            positionId: position.id,
            tokenSymbol: position.token_symbol,
            signature: signature,
            triggerType: triggerResult.trigger_type
        })

        const closeReasonMap: Record<
          string,
          'sl' | 'tp1' | 'tp2' | 'tp3' | 'strategy_deactivated' | 'sltp_monitor'
        > = {
            stop_loss:
              triggerResult.reason === 'strategy_deactivated'
                ? 'strategy_deactivated'
                : 'sl',
            take_profit_1: 'tp1',
            take_profit_2: 'tp2',
            take_profit_3: 'tp3',
        }

        try {
            const { finalizeBotPositionClose } = await import('@/utils/bot-position-close')
            await finalizeBotPositionClose({
                tokenAddress: position.token_address,
                tokenSymbol: position.token_symbol,
                walletAddress: position.wallet_address,
                strategyId: position.strategy_id || 'auto-trending',
                isSimulated: false,
                sellResult: {
                    success: true,
                    signature,
                    inputAmount: String(amountInUnits),
                    outputAmount: quoteResult.outAmount || '0',
                    fees: { totalFees: 0 },
                    provider: 'jupiter',
                    rpcUsed: 'default',
                },
                sellPercentage: triggerResult.sell_percentage,
                currentPriceUsd: triggerResult.current_price,
                initialPriceUsd: position.entry_price,
                tokenDecimals: decimals,
                closeReason:
                    closeReasonMap[triggerResult.trigger_type] || 'sltp_monitor',
                isFullClose,
                priorityFee: 1_000_000,
                strictRecord: true,
            })
        } catch (closeErr) {
            log.error(
                'sell_execution',
                'Failed to finalize bot position close after SL/TP sell',
                closeErr as Error,
                { positionId: position.id },
            )
        }

        return true

    } catch (error) {
        log.error('sell_execution', 'Failed to execute sell order', error as Error, {
            positionId: position.id,
            tokenSymbol: position.token_symbol
        })
        return false
    }
}

// Function to get active positions for a wallet
export async function getWalletSLTPPositions(walletAddress: string): Promise<SLTPPosition[]> {
    try {
        const { rows: positions } = await query<SLTPPosition>(
            `SELECT * FROM sl_tp_positions
             WHERE wallet_address = $1 AND is_active = true
             ORDER BY created_at DESC`,
            [walletAddress],
        )

        return positions

    } catch (error) {
        log.error('error_handling', 'Failed to get wallet SL/TP positions', error as Error, { walletAddress })
        return []
    }
}

// Function to remove/deactivate a position
export async function removeSLTPPosition(positionId: string): Promise<boolean> {
    try {
        await query(
            `UPDATE sl_tp_positions
             SET is_active = false, updated_at = $2,
                 close_reason = 'removed', closed_at = $2
             WHERE id = $1`,
            [positionId, new Date().toISOString()],
        )

        // Remove from cache
        for (const entry of Array.from(positionCache.entries())) {
            const [key, position] = entry;
            if (position.id === positionId) {
                positionCache.delete(key)
                break
            }
        }

        log.info('price_tracking', 'SL/TP position removed', { positionId })
        return true

    } catch (error) {
        log.error('error_handling', 'Failed to remove SL/TP position', error as Error, { positionId })
        return false
    }
}

// Function to clean up old inactive positions
export async function cleanupOldSLTPPositions(daysOld: number = 30): Promise<void> {
    try {
        const cutoffDate = new Date()
        cutoffDate.setDate(cutoffDate.getDate() - daysOld)

        await query(
            `DELETE FROM sl_tp_positions
             WHERE is_active = false AND updated_at < $1`,
            [cutoffDate.toISOString()],
        )

        log.info('price_tracking', 'Old SL/TP positions cleaned up', { daysOld })

    } catch (error) {
        log.error('error_handling', 'Failed to cleanup old SL/TP positions', error as Error)
    }
}

// ✅ NEW: Interface for tracking summary
export interface SLTPTrackingSummary {
    active_positions: SLTPPosition[]
    finished_positions: SLTPPosition[]
    statistics: {
        total_active: number
        total_finished: number
        active_by_type: { manual: number; bot: number }
        finished_by_trigger: {
            stop_loss: number
            take_profit_1: number
            take_profit_2: number
            take_profit_3: number
        }
        /**
         * Exactly one bucket per finished row, keyed by `close_reason`. This is the mutually
         * exclusive view — `finished_by_trigger` counts triggers, not positions, so a laddered
         * position appears in more than one of its buckets. Compute the backstop share from here.
         */
        by_reason: Record<string, number>
        /**
         * `max_hold` + `max_age` as a share of closes that carry a reason (S5). A health metric: it
         * measures how often the primary exit failed to fire, so it should be ~0.
         */
        backstop_share_pct: number
        /** The value `backstop_share_pct` is compared against before it logs a warning. */
        backstop_alert_pct: number
        /** The window `total_finished` counts over. Was silently 24h. */
        window_hours: number
        total_tracked_tokens: number
        unique_wallets: number
    }
    last_monitor_run: string
}

// ✅ NEW: Get comprehensive tracking summary
export async function getSLTPTrackingSummary(windowHours = 24): Promise<SLTPTrackingSummary> {
    try {
        // Epoch ms, not setHours: setHours mutates to local time, so "last 24h" shifted with the
        // server's timezone. The window is now explicit and reported back in `window_hours`.
        const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000)
        // Get all active positions
        const { rows: activePositions } = await query<SLTPPosition>(
            `SELECT * FROM sl_tp_positions
             WHERE is_active = true
             ORDER BY updated_at DESC`,
        )

        const { rows: finishedPositions } = await query<SLTPPosition>(
            `SELECT * FROM sl_tp_positions
             WHERE is_active = false AND COALESCE(closed_at, updated_at) >= $1
             ORDER BY COALESCE(closed_at, updated_at) DESC`,
            [windowStart.toISOString()],
        )

        // Calculate statistics
        const activeByType = { manual: 0, bot: 0 }
        const finishedByTrigger = { stop_loss: 0, take_profit_1: 0, take_profit_2: 0, take_profit_3: 0 }

        activePositions.forEach(pos => {
            activeByType[pos.position_type as 'manual' | 'bot']++
        })

        // WHICH trigger fired, from the flags. These remain non-exclusive by design: a laddered
        // position can legitimately touch more than one, so this counts triggers, not positions.
        finishedPositions.forEach(pos => {
            if (pos.sl_executed) finishedByTrigger.stop_loss++
            if (pos.tp1_executed) finishedByTrigger.take_profit_1++
            if (pos.tp2_executed) finishedByTrigger.take_profit_2++
            if (pos.tp3_executed) finishedByTrigger.take_profit_3++
        })

        // WHY it closed, from close_reason. Exactly one bucket per row, so this is the view S5's
        // backstop share and any alert have to be computed from. `unknown` counts rows closed before
        // the column existed, or by a writer that has not been taught to stamp it.
        const byReason: Record<string, number> = {}
        for (const pos of finishedPositions) {
            const reason = pos.close_reason ?? 'unknown'
            byReason[reason] = (byReason[reason] ?? 0) + 1
        }

        // S5: the backstop share is a HEALTH METRIC, not a statistic. `max_hold` firing means the
        // primary exit did not. It should be ~0, so it is computed against a closed-set
        // denominator (rows that actually carry a reason) and compared to an alerting threshold
        // rather than just printed.
        const reasonKnown = finishedPositions.filter((p) => p.close_reason != null).length
        const backstopCloses = (byReason.max_hold ?? 0) + (byReason.max_age ?? 0)
        const backstopSharePct =
            reasonKnown > 0 ? (backstopCloses / reasonKnown) * 100 : 0
        const backstopAlertPct = getExitBackstopAlertPct()
        if (reasonKnown > 0 && backstopSharePct > backstopAlertPct) {
            log.warn('price_tracking', 'Backstop share above threshold — primary exits are not firing', {
                backstopSharePct: Number(backstopSharePct.toFixed(1)),
                thresholdPct: backstopAlertPct,
                backstopCloses,
                reasonKnown,
                windowHours,
            })
        }

        const uniqueWallets = new Set([
            ...activePositions.map(p => p.wallet_address),
            ...finishedPositions.map(p => p.wallet_address)
        ]).size

        return {
            active_positions: activePositions,
            finished_positions: finishedPositions,
            statistics: {
                total_active: activePositions.length,
                total_finished: finishedPositions.length,
                active_by_type: activeByType,
                finished_by_trigger: finishedByTrigger,
                by_reason: byReason,
                backstop_share_pct: Number(backstopSharePct.toFixed(2)),
                backstop_alert_pct: backstopAlertPct,
                window_hours: windowHours,
                total_tracked_tokens: activePositions.length + finishedPositions.length,
                unique_wallets: uniqueWallets
            },
            last_monitor_run: new Date().toISOString()
        }

    } catch (error) {
        log.error('error_handling', 'Failed to get SL/TP tracking summary', error as Error)
        throw error
    }
}

/** `${chain}:${mint}` — a mint can exist on more than one chain, so the key carries both. */
function ruggedKey(chain: string | null | undefined, mint: string): string {
    return `${chain || 'sol'}:${mint}`
}

function isRugged(rugged: Set<string>, position: SLTPPosition): boolean {
    return rugged.has(ruggedKey(position.chain, position.token_address))
}

/**
 * The pass's known-rug mints, in ONE batched read.
 *
 * Fail-open in the strict sense: every failure path returns an empty set, so the evaluator falls
 * back to the price path exactly as it would without this input. A rug lookup must never be able to
 * block an exit — it can only ever ADD a reason to close.
 */
async function getRuggedMints(positions: SLTPPosition[]): Promise<Set<string>> {
    const mints = Array.from(new Set(positions.map((p) => p.token_address).filter(Boolean)))
    if (mints.length === 0) return new Set()
    const chains = Array.from(new Set(positions.map((p) => p.chain || 'sol')))
    try {
        const { rows } = await query<{ chain: string; token_address: string }>(
            `SELECT chain, token_address FROM token_mcap_tracking
              WHERE label = 'rugged'
                AND chain = ANY($1::text[])
                AND token_address = ANY($2::text[])`,
            [chains, mints],
        )
        return new Set(rows.map((r) => ruggedKey(r.chain, r.token_address)))
    } catch (error) {
        log.warn('price_tracking', 'Rug label lookup failed; exiting on price alone (fail-open)', {
            positions: positions.length,
            error: error instanceof Error ? error.message : String(error),
        })
        return new Set()
    }
}

export async function monitorSLTPPositions(returnSummary: boolean = false): Promise<SLTPTrackingSummary | void> {
    try {
        // Get all active positions
        const { rows: positions } = await query<SLTPPosition>(
            `SELECT * FROM sl_tp_positions WHERE is_active = true`,
        )

        if (positions.length === 0) {
            log.debug('price_tracking', 'No active SL/TP positions to monitor')
            if (returnSummary) {
                return await getSLTPTrackingSummary()
            }
            return
        }

        // ✅ Reconcile against wallet balances first to drop closed positions
        const { filteredPositions, pruned } = await reconcileClosedPositions(positions)
        if (pruned > 0) {
            log.info('price_tracking', 'Pruned inactive/closed positions before monitoring', { pruned, remaining: filteredPositions.length })
        }

        if (!filteredPositions || filteredPositions.length === 0) {
            log.debug('price_tracking', 'No active SL/TP positions to monitor after reconciliation')
            if (returnSummary) {
                return await getSLTPTrackingSummary()
            }
            return
        }

        log.info('price_tracking', 'Monitoring SL/TP positions', { count: filteredPositions.length })

        // Get current prices for all tokens
        const currentPrices = await getCurrentTokenPrices(filteredPositions)

        await persistCurrentPrices(filteredPositions, currentPrices)

        // The pass's rug set, one batched read resolved before the loop so nothing inside it does
        // per-position I/O. Fail-open by construction (see getRuggedMints).
        const ruggedMints = await getRuggedMints(filteredPositions)

        // Per-pass counters. `stale` is the one that matters: it used to be invisible, because a
        // position with no readable price was dropped before it could be counted.
        let staleCount = 0
        let ruggedCount = 0
        let shadowCount = 0

        // Check each position for triggers
        const triggerPromises = filteredPositions.map(async (position) => {
            let currentPrice = currentPrices.get(position.token_address)
            const rugged = isRugged(ruggedMints, position)
            let backstopResult: SLTPTriggerResult | null = null

            if (!currentPrice) {
                // NOT a silent skip. A position with no readable price is unevaluable, and that has
                // to be REPORTED rather than dropped — S4: never a hold we cannot see. The decision
                // still runs (with `stale`), which is what puts it in the pass's count and in the
                // log; what it returns is `stale`, not a close.
                staleCount += 1
                const staleResult = checkSLTPTriggers(position, 0, { stale: true, rugged })
                log.warn('price_tracking', 'No price data for token — reported STALE, not skipped', {
                    positionId: position.id,
                    tokenAddress: position.token_address,
                    tokenSymbol: position.token_symbol,
                    rugged,
                    decision: staleResult.reason,
                })
                // The backstops (rugged / max-hold) do not need a live price, only a price to book
                // the close at. Without this an unpriced position could never age out or retire on a
                // rug label — the one state the stale count made visible but nothing resolved.
                backstopResult = resolveUnpricedBackstop(position, rugged)
                if (!backstopResult) return
                currentPrice = backstopResult.current_price
                log.warn('price_tracking', 'Unpriced position closed by backstop on last known price', {
                    positionId: position.id,
                    tokenSymbol: position.token_symbol,
                    triggerType: backstopResult.trigger_type,
                    lastPrice: currentPrice,
                })
            }

            if (rugged) ruggedCount += 1

            // Check for triggers
            const triggerResult = backstopResult ?? checkSLTPTriggers(position, currentPrice, { rugged })

            if (triggerResult.triggered) {
                log.info('deviation_alert', 'SL/TP trigger detected', {
                    positionId: position.id,
                    tokenSymbol: position.token_symbol,
                    triggerType: triggerResult.trigger_type,
                    reason: triggerResult.reason
                })

                if (isSimulatedPosition(position)) {
                    // Paper: close the TRADE, never the chain. The closer writes the sell record and
                    // the outcome; the mirror is retired only when that succeeded, so a failed close
                    // stays open and is retried on the next pass rather than silently vanishing.
                    const closeResult = await closeSimulatedPositionFromWorker({
                        position,
                        triggerType: triggerResult.trigger_type,
                        currentPrice,
                    })
                    log.info('deviation_alert', 'Simulated SL/TP trigger recorded (no on-chain sell)', {
                        positionId: position.id,
                        tokenSymbol: position.token_symbol,
                        triggerType: triggerResult.trigger_type,
                        domain: closeResult.domain,
                        closed: closeResult.closed,
                    })
                    if (!closeResult.closed) {
                        // No closer owns this family, so this is a SHADOW: the worker evaluated the
                        // position, the trigger fired, and it declines to act. That is how a strategy
                        // gets compared against its own ladder before anything enforces the
                        // comparison — `att_rh` today, whose `decideRhTrendingExit` ladder still owns
                        // its exits. Reported with the fields needed to compare the two.
                        shadowCount += 1
                        log.info('deviation_alert', 'SHADOW — trigger fired, no closer owns this family', {
                            positionId: position.id,
                            strategyId: position.strategy_id,
                            tokenSymbol: position.token_symbol,
                            triggerType: triggerResult.trigger_type,
                            sellPercentage: triggerResult.sell_percentage,
                            gainPercentage: triggerResult.gain_percentage,
                        })
                    }
                    if (closeResult.alreadyClosed) {
                        // A pass killed between the outcome write and the mirror update leaves exactly
                        // this. Reported rather than silent, because it means the previous pass did
                        // not finish — the mirror is retired and nothing else is written.
                        log.warn('deviation_alert', 'Already closed — retiring the mirror only', {
                            positionId: position.id,
                            tokenSymbol: position.token_symbol,
                            triggerType: triggerResult.trigger_type,
                        })
                    }
                    if (closeResult.closed) {
                        await markSimulatedPositionClosed(position, triggerResult)
                    }
                } else {
                    // Execute sell order
                    await executeSellOrder(position, triggerResult)
                }
            }
        })

        await Promise.all(triggerPromises)

        // Always reported, even at zero. A count that only appears when non-zero is a count nobody
        // notices is missing, and `stale` is precisely the state that used to be invisible.
        log.info('price_tracking', 'Pass exit evaluation summary', {
            positions: filteredPositions.length,
            stale: staleCount,
            rugged: ruggedCount,
            shadow: shadowCount,
        })

        // Return summary if requested
        if (returnSummary) {
            return await getSLTPTrackingSummary()
        }

    } catch (error) {
        log.error('error_handling', 'Error monitoring SL/TP positions', error as Error)
        if (returnSummary) {
            // Return summary even on error for cronjob visibility
            try {
                return await getSLTPTrackingSummary()
            } catch (summaryError) {
                log.error('error_handling', 'Error getting summary after monitor failure', summaryError as Error)
                throw error
            }
        }
        throw error
    }
}
export async function runSLTPMonitorAndSummarize(): Promise<SLTPTrackingSummary> {
    try {
        // Get all active positions
        const { rows: positions } = await query<SLTPPosition>(
            `SELECT * FROM sl_tp_positions WHERE is_active = true`,
        )

        if (positions.length === 0) {
            log.debug('price_tracking', 'No active SL/TP positions to monitor')
            return await getSLTPTrackingSummary()
        }

        // ✅ Reconcile against wallet balances first to drop closed positions
        const { filteredPositions, pruned } = await reconcileClosedPositions(positions)
        if (pruned > 0) {
            log.info('price_tracking', 'Pruned inactive/closed positions before monitoring', { pruned, remaining: filteredPositions.length })
        }

        if (!filteredPositions || filteredPositions.length === 0) {
            log.debug('price_tracking', 'No active SL/TP positions to monitor after reconciliation')
            return await getSLTPTrackingSummary()
        }

        log.info('price_tracking', 'Monitoring SL/TP positions', { count: filteredPositions.length })

        // Get current prices for all tokens
        const currentPrices = await getCurrentTokenPrices(filteredPositions)

        await persistCurrentPrices(filteredPositions, currentPrices)

        // The pass's rug set, one batched read resolved before the loop so nothing inside it does
        // per-position I/O. Fail-open by construction (see getRuggedMints).
        const ruggedMints = await getRuggedMints(filteredPositions)

        // Per-pass counters. `stale` is the one that matters: it used to be invisible, because a
        // position with no readable price was dropped before it could be counted.
        let staleCount = 0
        let ruggedCount = 0
        let shadowCount = 0

        // Check each position for triggers
        const triggerPromises = filteredPositions.map(async (position) => {
            let currentPrice = currentPrices.get(position.token_address)
            const rugged = isRugged(ruggedMints, position)
            let backstopResult: SLTPTriggerResult | null = null

            if (!currentPrice) {
                // NOT a silent skip. A position with no readable price is unevaluable, and that has
                // to be REPORTED rather than dropped — S4: never a hold we cannot see. The decision
                // still runs (with `stale`), which is what puts it in the pass's count and in the
                // log; what it returns is `stale`, not a close.
                staleCount += 1
                const staleResult = checkSLTPTriggers(position, 0, { stale: true, rugged })
                log.warn('price_tracking', 'No price data for token — reported STALE, not skipped', {
                    positionId: position.id,
                    tokenAddress: position.token_address,
                    tokenSymbol: position.token_symbol,
                    rugged,
                    decision: staleResult.reason,
                })
                // The backstops (rugged / max-hold) do not need a live price, only a price to book
                // the close at. Without this an unpriced position could never age out or retire on a
                // rug label — the one state the stale count made visible but nothing resolved.
                backstopResult = resolveUnpricedBackstop(position, rugged)
                if (!backstopResult) return
                currentPrice = backstopResult.current_price
                log.warn('price_tracking', 'Unpriced position closed by backstop on last known price', {
                    positionId: position.id,
                    tokenSymbol: position.token_symbol,
                    triggerType: backstopResult.trigger_type,
                    lastPrice: currentPrice,
                })
            }

            if (rugged) ruggedCount += 1

            // Check for triggers
            const triggerResult = backstopResult ?? checkSLTPTriggers(position, currentPrice, { rugged })

            if (triggerResult.triggered) {
                log.info('deviation_alert', 'SL/TP trigger detected', {
                    positionId: position.id,
                    tokenSymbol: position.token_symbol,
                    triggerType: triggerResult.trigger_type,
                    reason: triggerResult.reason
                })

                if (isSimulatedPosition(position)) {
                    // Paper: close the TRADE, never the chain. The closer writes the sell record and
                    // the outcome; the mirror is retired only when that succeeded, so a failed close
                    // stays open and is retried on the next pass rather than silently vanishing.
                    const closeResult = await closeSimulatedPositionFromWorker({
                        position,
                        triggerType: triggerResult.trigger_type,
                        currentPrice,
                    })
                    log.info('deviation_alert', 'Simulated SL/TP trigger recorded (no on-chain sell)', {
                        positionId: position.id,
                        tokenSymbol: position.token_symbol,
                        triggerType: triggerResult.trigger_type,
                        domain: closeResult.domain,
                        closed: closeResult.closed,
                    })
                    if (!closeResult.closed) {
                        // No closer owns this family, so this is a SHADOW: the worker evaluated the
                        // position, the trigger fired, and it declines to act. That is how a strategy
                        // gets compared against its own ladder before anything enforces the
                        // comparison — `att_rh` today, whose `decideRhTrendingExit` ladder still owns
                        // its exits. Reported with the fields needed to compare the two.
                        shadowCount += 1
                        log.info('deviation_alert', 'SHADOW — trigger fired, no closer owns this family', {
                            positionId: position.id,
                            strategyId: position.strategy_id,
                            tokenSymbol: position.token_symbol,
                            triggerType: triggerResult.trigger_type,
                            sellPercentage: triggerResult.sell_percentage,
                            gainPercentage: triggerResult.gain_percentage,
                        })
                    }
                    if (closeResult.alreadyClosed) {
                        // A pass killed between the outcome write and the mirror update leaves exactly
                        // this. Reported rather than silent, because it means the previous pass did
                        // not finish — the mirror is retired and nothing else is written.
                        log.warn('deviation_alert', 'Already closed — retiring the mirror only', {
                            positionId: position.id,
                            tokenSymbol: position.token_symbol,
                            triggerType: triggerResult.trigger_type,
                        })
                    }
                    if (closeResult.closed) {
                        await markSimulatedPositionClosed(position, triggerResult)
                    }
                } else {
                    // Execute sell order
                    await executeSellOrder(position, triggerResult)
                }
            }
        })

        await Promise.all(triggerPromises)

        // Always reported, even at zero. A count that only appears when non-zero is a count nobody
        // notices is missing, and `stale` is precisely the state that used to be invisible.
        log.info('price_tracking', 'Pass exit evaluation summary', {
            positions: filteredPositions.length,
            stale: staleCount,
            rugged: ruggedCount,
            shadow: shadowCount,
        })

        // Return summary
        return await getSLTPTrackingSummary()

    } catch (error) {
        log.error('error_handling', 'Error monitoring SL/TP positions', error as Error)
        // Try to return summary even on failure
        try {
            return await getSLTPTrackingSummary()
        } catch {
            throw error
        }
    }
}