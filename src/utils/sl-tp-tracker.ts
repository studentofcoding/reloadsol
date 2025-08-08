import { supabase } from '@/utils/supabase'
import { log } from '@/utils/unified-logger'
import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import { getSwapQuote, getSwapTransaction } from '@/utils/jupiter'
import { notifySlTpTrigger } from './trading-notifications'
import { connection } from '@/utils/solana'
import { fetchUserTokens } from '@/utils/jupiter'

export interface SLTPPosition {
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
    trigger_type: 'stop_loss' | 'take_profit_1' | 'take_profit_2' | 'take_profit_3' | 'max_hold_time'
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

// Trading connection (will be initialized when needed)
let tradingConnection: Connection | null = null
let tradingKeypair: Keypair | null = null

// Initialize trading connection
async function initializeTradingConnection(): Promise<void> {
    if (tradingConnection && tradingKeypair) return

    try {
        // Use the existing connection from solana utils
        tradingConnection = connection

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
        // Get trading records from the API (same as PnLTracker)
        const response = await fetch(`/api/trading/records?wallet=${encodeURIComponent(walletAddress)}`)
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
                const publicKey = new PublicKey(walletAddress)
                const walletTokens = await fetchUserTokens(connection, publicKey, false, false)

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
        const { data: existingPositions, error: fetchError } = await supabase
            .from('sl_tp_positions')
            .select('token_address')
            .eq('wallet_address', walletAddress)
            .eq('is_active', true)

        if (fetchError) {
            throw fetchError
        }

        const existingTokens = new Set(existingPositions?.map(p => p.token_address) || [])

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

        const { data, error } = await supabase
            .from('sl_tp_positions')
            .insert(position)
            .select('id')
            .single()

        if (error) throw error

        // Cache the position
        const fullPosition = { ...position, id: data.id }
        positionCache.set(`${walletAddress}_${tokenAddress}`, fullPosition)

        log.info('price_tracking', 'SL/TP position added', {
            positionId: data.id,
            tokenSymbol,
            positionType,
            stopLossPercentage,
            takeProfitPercentage
        })

        return data.id

    } catch (error) {
        log.error('error_handling', 'Failed to add SL/TP position', error as Error, { params })
        throw error
    }
}

// Function to get current token prices
async function getCurrentTokenPrices(tokenAddresses: string[]): Promise<Map<string, number>> {
    try {
        const { fetchTokenPricesForTracking } = await import('@/utils/trading-tracker')
        const prices = await fetchTokenPricesForTracking(tokenAddresses)

        const priceMap = new Map<string, number>()
        for (const [address, price] of Object.entries(prices)) {
            if (typeof price === 'number' && price > 0) {
                priceMap.set(address, price)
            }
        }

        return priceMap
    } catch (error) {
        log.error('price_tracking', 'Failed to fetch token prices', error as Error)
        return new Map()
    }
}

// Function to check SL/TP triggers for a position
function checkSLTPTriggers(position: SLTPPosition, currentPrice: number): SLTPTriggerResult {
    const gainPercentage = ((currentPrice - position.entry_price) / position.entry_price) * 100

    // Check Stop Loss
    if (gainPercentage <= position.stop_loss_percentage && !position.sl_executed) {
        return {
            triggered: true,
            trigger_type: 'stop_loss',
            sell_percentage: 100,
            current_price: currentPrice,
            trigger_price: position.stop_loss_price,
            gain_percentage: gainPercentage,
            reason: `Stop loss triggered: ${gainPercentage.toFixed(2)}% <= ${position.stop_loss_percentage}%`
        }
    }

    // For bot positions, check multiple TP levels
    if (position.position_type === 'bot') {
        // Check TP1
        if (position.tp1_percentage && !position.tp1_executed && gainPercentage >= position.tp1_percentage) {
            return {
                triggered: true,
                trigger_type: 'take_profit_1',
                sell_percentage: position.tp1_sell_percentage || 80,
                current_price: currentPrice,
                trigger_price: position.entry_price * (1 + position.tp1_percentage / 100),
                gain_percentage: gainPercentage,
                reason: `TP1 triggered: ${gainPercentage.toFixed(2)}% >= ${position.tp1_percentage}%`
            }
        }

        // Check TP2 (only if TP1 was executed)
        if (position.tp2_percentage && position.tp1_executed && !position.tp2_executed && gainPercentage >= position.tp2_percentage) {
            return {
                triggered: true,
                trigger_type: 'take_profit_2',
                sell_percentage: 100,
                current_price: currentPrice,
                trigger_price: position.entry_price * (1 + position.tp2_percentage / 100),
                gain_percentage: gainPercentage,
                reason: `TP2 triggered: ${gainPercentage.toFixed(2)}% >= ${position.tp2_percentage}%`
            }
        }

        // Check TP3 (trailing stop after TP1)
        if (position.tp3_percentage && position.tp3_enabled && position.tp1_executed && !position.tp3_executed && gainPercentage <= position.tp3_percentage) {
            return {
                triggered: true,
                trigger_type: 'take_profit_3',
                sell_percentage: 100,
                current_price: currentPrice,
                trigger_price: position.entry_price * (1 + position.tp3_percentage / 100),
                gain_percentage: gainPercentage,
                reason: `TP3 (trailing stop) triggered: ${gainPercentage.toFixed(2)}% <= ${position.tp3_percentage}% after TP1`
            }
        }
    } else {
        // For manual positions, simple TP check
        if (gainPercentage >= position.take_profit_percentage) {
            return {
                triggered: true,
                trigger_type: 'take_profit_1',
                sell_percentage: 100,
                current_price: currentPrice,
                trigger_price: position.take_profit_price,
                gain_percentage: gainPercentage,
                reason: `Take profit triggered: ${gainPercentage.toFixed(2)}% >= ${position.take_profit_percentage}%`
            }
        }
    }

    return {
        triggered: false,
        trigger_type: 'stop_loss',
        sell_percentage: 0,
        current_price: currentPrice,
        trigger_price: 0,
        gain_percentage: gainPercentage,
        reason: 'No triggers met'
    }
}

// Function to execute sell order
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

        // Calculate token amount to sell
        const sellAmount = (position.position_size * triggerResult.sell_percentage) / 100

        log.info('sell_execution', 'Executing sell order', {
            positionId: position.id,
            tokenSymbol: position.token_symbol,
            triggerType: triggerResult.trigger_type,
            sellPercentage: triggerResult.sell_percentage,
            sellAmount,
            currentPrice: triggerResult.current_price
        })

        // Get swap quote
        const quoteResult = await getSwapQuote(
            position.token_address,
            'So11111111111111111111111111111111111111112', // SOL
            Math.floor(sellAmount * 1e6), // Convert to token decimals
            300 // 3% slippage
        )

        if (!quoteResult) {
            throw new Error('Quote failed: No quote returned')
        }

        // Execute swap
        const swapResult = await getSwapTransaction(
            quoteResult,
            tradingKeypair.publicKey.toBase58(),
            1000000 // 0.001 SOL priority fee
        )

        if (!swapResult) {
            throw new Error('Swap failed: No swap result returned')
        }

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
        }

        await supabase
            .from('sl_tp_positions')
            .update(updateData)
            .eq('id', position.id)

        // Send notification
        try {
            await notifySlTpTrigger(
                position.wallet_address,
                position.token_symbol,
                triggerResult.trigger_type,
                triggerResult.gain_percentage,
                triggerResult.sell_percentage,
                (swapResult as any).signature || 'unknown'
            )
        } catch (notifyError) {
            log.error('discord_notification', 'Failed to send notification', notifyError as Error)
        }

        log.info('sell_execution', 'Sell order executed successfully', {
            positionId: position.id,
            tokenSymbol: position.token_symbol,
            signature: (swapResult as any).signature || 'unknown',
            triggerType: triggerResult.trigger_type
        })

        return true

    } catch (error) {
        log.error('sell_execution', 'Failed to execute sell order', error as Error, {
            positionId: position.id,
            tokenSymbol: position.token_symbol
        })
        return false
    }
}

// Main function to monitor all active SL/TP positions
export async function monitorSLTPPositions(): Promise<void> {
    try {
        // Get all active positions
        const { data: positions, error } = await supabase
            .from('sl_tp_positions')
            .select('*')
            .eq('is_active', true)

        if (error) throw error

        if (!positions || positions.length === 0) {
            log.debug('price_tracking', 'No active SL/TP positions to monitor')
            return
        }

        log.info('price_tracking', 'Monitoring SL/TP positions', { count: positions.length })

        // Get current prices for all tokens
        const tokenAddresses = positions.map(p => p.token_address)
        const currentPrices = await getCurrentTokenPrices(tokenAddresses)

        // Check each position for triggers
        const triggerPromises = positions.map(async (position) => {
            const currentPrice = currentPrices.get(position.token_address)

            if (!currentPrice) {
                log.warn('price_tracking', 'No price data for token', {
                    tokenAddress: position.token_address,
                    tokenSymbol: position.token_symbol
                })
                return
            }

            // Update current price in database
            await supabase
                .from('sl_tp_positions')
                .update({
                    current_price: currentPrice,
                    updated_at: new Date().toISOString()
                })
                .eq('id', position.id)

            // Check for triggers
            const triggerResult = checkSLTPTriggers(position, currentPrice)

            if (triggerResult.triggered) {
                log.info('deviation_alert', 'SL/TP trigger detected', {
                    positionId: position.id,
                    tokenSymbol: position.token_symbol,
                    triggerType: triggerResult.trigger_type,
                    reason: triggerResult.reason
                })

                // Execute sell order
                await executeSellOrder(position, triggerResult)
            }
        })

        await Promise.all(triggerPromises)

    } catch (error) {
        log.error('error_handling', 'Error monitoring SL/TP positions', error as Error)
    }
}

// Function to get active positions for a wallet
export async function getWalletSLTPPositions(walletAddress: string): Promise<SLTPPosition[]> {
    try {
        const { data: positions, error } = await supabase
            .from('sl_tp_positions')
            .select('*')
            .eq('wallet_address', walletAddress)
            .eq('is_active', true)
            .order('created_at', { ascending: false })

        if (error) throw error

        return positions || []

    } catch (error) {
        log.error('error_handling', 'Failed to get wallet SL/TP positions', error as Error, { walletAddress })
        return []
    }
}

// Function to remove/deactivate a position
export async function removeSLTPPosition(positionId: string): Promise<boolean> {
    try {
        const { error } = await supabase
            .from('sl_tp_positions')
            .update({
                is_active: false,
                updated_at: new Date().toISOString()
            })
            .eq('id', positionId)

        if (error) throw error

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

        const { error } = await supabase
            .from('sl_tp_positions')
            .delete()
            .eq('is_active', false)
            .lt('updated_at', cutoffDate.toISOString())

        if (error) throw error

        log.info('price_tracking', 'Old SL/TP positions cleaned up', { daysOld })

    } catch (error) {
        log.error('error_handling', 'Failed to cleanup old SL/TP positions', error as Error)
    }
}