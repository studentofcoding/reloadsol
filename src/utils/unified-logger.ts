import { NextRequest, NextResponse } from 'next/server'

// Log levels
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical'

// Trade operation types
export type TradeOperationType =
    | 'token_detection'
    | 'buy_execution'
    | 'sell_execution'
    | 'price_tracking'
    | 'deviation_alert'
    | 'api_request'
    | 'discord_notification'
    | 'error_handling'
    | 'mcap_tracker'

// Base log entry interface
interface BaseLogEntry {
    requestId?: string
    level: LogLevel
    operation: TradeOperationType
    message: string
    timestamp: string
    duration?: number
    metadata?: Record<string, any>
    error?: {
        message: string
        stack?: string
        code?: string
    }
}

// API-specific log entry
interface ApiLogEntry extends BaseLogEntry {
    endpoint?: string
    method?: string
    request?: {
        path: string
        query?: Record<string, string>
        headers?: Record<string, string>
        userAgent?: string
        ip?: string
        contentLength?: number
    }
    response?: {
        statusCode: number
        contentLength?: number
        headers?: Record<string, string>
    }
}

// Trade-specific log entry
interface TradeLogEntry extends BaseLogEntry {
    tokenAddress?: string
    tokenSymbol?: string
    tradeData?: {
        amountSOL?: number
        tokensReceived?: string
        priceUSD?: number
        provider?: string
        rpcUsed?: string
        signature?: string
        totalFees?: number
        isSimulated?: boolean
    }
}

// In-memory log storage
const logBuffer: (ApiLogEntry | TradeLogEntry)[] = []
const MAX_LOG_ENTRIES = 1000

// Color codes for console output
const colors = {
    debug: '\x1b[36m',   // Cyan
    info: '\x1b[32m',    // Green
    warn: '\x1b[33m',    // Yellow
    error: '\x1b[31m',   // Red
    critical: '\x1b[35m', // Magenta
    reset: '\x1b[0m'
}

// Operation emojis for better visual identification
const operationEmojis = {
    token_detection: '🔍',
    buy_execution: '💰',
    sell_execution: '💸',
    price_tracking: '📊',
    deviation_alert: '⚠️',
    api_request: '🌐',
    discord_notification: '📢',
    error_handling: '🚨',
    mcap_tracker: '📈'
}

// Generate unique request ID
export function generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

// Core logging function
function writeLog(entry: ApiLogEntry | TradeLogEntry): void {
    // Add to buffer
    logBuffer.push(entry)

    // Trim buffer if needed
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES)
    }

    // Console output with colors and emojis
    const color = colors[entry.level] || colors.reset
    const resetColor = colors.reset
    const emoji = operationEmojis[entry.operation] || '📝'

    const prefix = `${color}[${entry.level.toUpperCase()}]${resetColor}`
    const timestamp = `[${new Date(entry.timestamp).toISOString()}]`
    const operation = `${emoji} [${entry.operation.toUpperCase()}]`
    const duration = entry.duration ? `[${entry.duration}ms]` : ''
    const requestId = entry.requestId ? `[${entry.requestId}]` : ''

    // Different output formats for API vs Trade logs
    if ('endpoint' in entry && entry.endpoint) {
        const method = entry.method || 'UNKNOWN'
        const status = entry.response?.statusCode ? `[${entry.response.statusCode}]` : ''
        console.log(`${prefix} ${timestamp} ${operation} ${requestId} [${method} ${entry.endpoint}] ${status} ${duration} - ${entry.message}`)
    } else {
        const tokenInfo = 'tokenSymbol' in entry && entry.tokenSymbol ? `[${entry.tokenSymbol}]` : ''
        console.log(`${prefix} ${timestamp} ${operation} ${requestId} ${tokenInfo} ${duration} - ${entry.message}`)
    }

    // Log additional details for errors and critical issues
    if (entry.level === 'error' || entry.level === 'critical') {
        if (entry.error) {
            console.error(`  ❌ Error: ${entry.error.message}`)
            if (entry.error.stack && process.env.NODE_ENV === 'development') {
                console.error(`  📋 Stack: ${entry.error.stack}`)
            }
        }
        if (entry.metadata) {
            console.error(`  📊 Metadata:`, JSON.stringify(entry.metadata, null, 2))
        }
    }

    // Log trade data for trade operations
    if ('tradeData' in entry && entry.tradeData && entry.level === 'info') {
        const trade = entry.tradeData
        if (trade.amountSOL || trade.tokensReceived) {
            console.log(`  💱 Trade Details: ${trade.amountSOL || 'N/A'} SOL → ${trade.tokensReceived || 'N/A'} tokens @ $${trade.priceUSD?.toFixed(8) || 'N/A'}`)
        }
        if (trade.provider) {
            console.log(`  🔗 Provider: ${trade.provider} | RPC: ${trade.rpcUsed || 'N/A'} | Fees: ${trade.totalFees?.toFixed(6) || 'N/A'} SOL`)
        }
    }
}

// Unified Logger class
export class UnifiedLogger {
    private requestId?: string
    private requestMetadata?: {
        method: string
        path: string
        userAgent?: string
        ip?: string
        timestamp: string
    }

    constructor(request?: NextRequest, requestId?: string) {
        this.requestId = requestId || (request ? generateRequestId() : undefined)

        if (request) {
            const url = new URL(request.url)
            this.requestMetadata = {
                method: request.method,
                path: url.pathname,
                userAgent: request.headers.get('user-agent') || undefined,
                ip: request.headers.get('x-forwarded-for') ||
                    request.headers.get('x-real-ip') ||
                    'unknown',
                timestamp: new Date().toISOString()
            }
        }
    }

    // Get request ID
    getRequestId(): string | undefined {
        return this.requestId
    }

    // Core logging methods
    debug(operation: TradeOperationType, message: string, metadata?: Record<string, any>): void {
        this.log('debug', operation, message, metadata)
    }

    info(operation: TradeOperationType, message: string, metadata?: Record<string, any>): void {
        this.log('info', operation, message, metadata)
    }

    warn(operation: TradeOperationType, message: string, metadata?: Record<string, any>): void {
        this.log('warn', operation, message, metadata)
    }

    error(operation: TradeOperationType, message: string, error?: Error, metadata?: Record<string, any>): void {
        this.log('error', operation, message, metadata, error)
    }

    critical(operation: TradeOperationType, message: string, error?: Error, metadata?: Record<string, any>): void {
        this.log('critical', operation, message, metadata, error)
    }

    // Trade-specific logging methods
    logTradeOperation(operation: TradeOperationType, data: any, error?: Error): void {
        const entry: TradeLogEntry = {
            requestId: this.requestId,
            level: error ? 'error' : 'info',
            operation,
            message: error ? `Trade operation failed: ${operation}` : `Trade operation completed: ${operation}`,
            timestamp: new Date().toISOString(),
            metadata: data,
            tokenAddress: data.tokenAddress,
            tokenSymbol: data.tokenSymbol,
            tradeData: data.tradeData || {
                amountSOL: data.amountSOL,
                tokensReceived: data.tokensReceived,
                priceUSD: data.priceUSD,
                provider: data.provider,
                rpcUsed: data.rpcUsed,
                signature: data.signature,
                totalFees: data.totalFees,
                isSimulated: data.isSimulated
            },
            error: error ? {
                message: error.message,
                stack: error.stack,
                code: (error as any).code
            } : undefined
        }

        writeLog(entry)
    }

    // API-specific logging methods
    logApiRequest(endpoint: string, method: string, message: string, metadata?: Record<string, any>): void {
        const entry: ApiLogEntry = {
            requestId: this.requestId,
            level: 'info',
            operation: 'api_request',
            message,
            timestamp: new Date().toISOString(),
            endpoint,
            method,
            request: this.requestMetadata ? {
                path: this.requestMetadata.path,
                userAgent: this.requestMetadata.userAgent,
                ip: this.requestMetadata.ip
            } : undefined,
            metadata
        }

        writeLog(entry)
    }

    logApiResponse(response: NextResponse | Response, startTime: number, endpoint?: string, method?: string): void {
        const duration = Date.now() - startTime
        const statusCode = response.status

        const entry: ApiLogEntry = {
            requestId: this.requestId,
            level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
            operation: 'api_request',
            message: `API request completed`,
            timestamp: new Date().toISOString(),
            duration,
            endpoint: endpoint || this.requestMetadata?.path,
            method: method || this.requestMetadata?.method,
            request: this.requestMetadata ? {
                path: this.requestMetadata.path,
                userAgent: this.requestMetadata.userAgent,
                ip: this.requestMetadata.ip
            } : undefined,
            response: {
                statusCode,
                contentLength: response.headers.get('content-length') ?
                    parseInt(response.headers.get('content-length')!) : undefined,
                headers: {
                    'content-type': response.headers.get('content-type') || '',
                    'cache-control': response.headers.get('cache-control') || ''
                }
            }
        }

        writeLog(entry)
    }

    // Performance tracking
    startTimer(): number {
        return Date.now()
    }

    logPerformance(operation: TradeOperationType, startTime: number, message: string, metadata?: Record<string, any>): void {
        const duration = Date.now() - startTime
        this.log('info', operation, `${message} (${duration}ms)`, { ...metadata, duration })
    }

    // Private core log method
    private log(level: LogLevel, operation: TradeOperationType, message: string, metadata?: Record<string, any>, error?: Error): void {
        const entry: BaseLogEntry = {
            requestId: this.requestId,
            level,
            operation,
            message,
            timestamp: new Date().toISOString(),
            metadata,
            error: error ? {
                message: error.message,
                stack: error.stack,
                code: (error as any).code
            } : undefined
        }

        writeLog(entry)
    }
}

// Static utility functions for backward compatibility
export function logTradeOperation(operation: string, data: any, error?: Error): void {
    const logger = new UnifiedLogger()
    logger.logTradeOperation(operation as TradeOperationType, data, error)
}

// Middleware wrapper for automatic request/response logging
export function withUnifiedLogging<T>(
    handler: (request: NextRequest, logger: UnifiedLogger) => Promise<T>
) {
    return async (request: NextRequest): Promise<T> => {
        const logger = new UnifiedLogger(request)
        const startTime = Date.now()

        // Log request start
        logger.logApiRequest(
            new URL(request.url).pathname,
            request.method,
            'API request started'
        )

        try {
            const result = await handler(request, logger)

            // If result is a NextResponse, log it
            if (result instanceof NextResponse) {
                logger.logApiResponse(result, startTime)
            }

            return result
        } catch (error) {
            const duration = Date.now() - startTime
            logger.error('api_request', `API request failed after ${duration}ms`, error as Error)
            throw error
        }
    }
}

// Utility functions for log retrieval and filtering
export function getLogs(options?: {
    level?: LogLevel
    operation?: TradeOperationType
    endpoint?: string
    method?: string
    tokenSymbol?: string
    limit?: number
    since?: string
}): (ApiLogEntry | TradeLogEntry)[] {
    let filtered = [...logBuffer]

    if (options?.level) {
        filtered = filtered.filter(log => log.level === options.level)
    }

    if (options?.operation) {
        filtered = filtered.filter(log => log.operation === options.operation)
    }

    if (options?.endpoint) {
        filtered = filtered.filter(log =>
            'endpoint' in log && log.endpoint?.includes(options.endpoint!)
        )
    }

    if (options?.method) {
        filtered = filtered.filter(log =>
            'method' in log && log.method === options.method
        )
    }

    if (options?.tokenSymbol) {
        filtered = filtered.filter(log =>
            'tokenSymbol' in log && log.tokenSymbol === options.tokenSymbol
        )
    }

    if (options?.since) {
        const sinceDate = new Date(options.since)
        filtered = filtered.filter(log => new Date(log.timestamp) >= sinceDate)
    }

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    if (options?.limit) {
        filtered = filtered.slice(0, options.limit)
    }

    return filtered
}

// Get comprehensive stats
export function getLogStats(): {
    totalLogs: number
    logsByLevel: Record<LogLevel, number>
    logsByOperation: Record<TradeOperationType, number>
    logsByEndpoint: Record<string, number>
    averageResponseTime: number
    errorRate: number
    tradeStats: {
        totalTrades: number
        successfulTrades: number
        failedTrades: number
        averageTradeValue: number
    }
} {
    const stats = {
        totalLogs: logBuffer.length,
        logsByLevel: {} as Record<LogLevel, number>,
        logsByOperation: {} as Record<TradeOperationType, number>,
        logsByEndpoint: {} as Record<string, number>,
        averageResponseTime: 0,
        errorRate: 0,
        tradeStats: {
            totalTrades: 0,
            successfulTrades: 0,
            failedTrades: 0,
            averageTradeValue: 0
        }
    }

    // Initialize counters
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'critical']
    levels.forEach(level => stats.logsByLevel[level] = 0)

    let totalDuration = 0
    let responseCount = 0
    let errorCount = 0
    let totalTradeValue = 0

    logBuffer.forEach(log => {
        // Count by level
        stats.logsByLevel[log.level]++

        // Count by operation
        stats.logsByOperation[log.operation] = (stats.logsByOperation[log.operation] || 0) + 1

        // Count by endpoint (for API logs)
        if ('endpoint' in log && log.endpoint) {
            stats.logsByEndpoint[log.endpoint] = (stats.logsByEndpoint[log.endpoint] || 0) + 1
        }

        // Calculate average response time
        if (log.duration) {
            totalDuration += log.duration
            responseCount++
        }

        // Count errors
        if (log.level === 'error' || log.level === 'critical') {
            errorCount++
        }

        // Trade statistics
        if (log.operation === 'buy_execution' || log.operation === 'sell_execution') {
            stats.tradeStats.totalTrades++

            if (log.level === 'info') {
                stats.tradeStats.successfulTrades++
            } else if (log.level === 'error') {
                stats.tradeStats.failedTrades++
            }

            // Calculate trade value if available
            if ('tradeData' in log && log.tradeData?.amountSOL) {
                totalTradeValue += log.tradeData.amountSOL
            }
        }
    })

    stats.averageResponseTime = responseCount > 0 ? Math.round(totalDuration / responseCount) : 0
    stats.errorRate = logBuffer.length > 0 ? Math.round((errorCount / logBuffer.length) * 100) : 0
    stats.tradeStats.averageTradeValue = stats.tradeStats.totalTrades > 0 ?
        Math.round((totalTradeValue / stats.tradeStats.totalTrades) * 1000) / 1000 : 0

    return stats
}

// Clear logs (useful for testing)
export function clearLogs(): void {
    logBuffer.length = 0
}

// Export singleton instance for global use
export const globalLogger = new UnifiedLogger()

// Convenience functions for quick logging without instantiation
export const log = {
    debug: (operation: TradeOperationType, message: string, metadata?: Record<string, any>) =>
        globalLogger.debug(operation, message, metadata),

    info: (operation: TradeOperationType, message: string, metadata?: Record<string, any>) =>
        globalLogger.info(operation, message, metadata),

    warn: (operation: TradeOperationType, message: string, metadata?: Record<string, any>) =>
        globalLogger.warn(operation, message, metadata),

    error: (operation: TradeOperationType, message: string, error?: Error, metadata?: Record<string, any>) =>
        globalLogger.error(operation, message, error, metadata),

    critical: (operation: TradeOperationType, message: string, error?: Error, metadata?: Record<string, any>) =>
        globalLogger.critical(operation, message, error, metadata),

    trade: (operation: TradeOperationType, data: any, error?: Error) =>
        globalLogger.logTradeOperation(operation, data, error),

    performance: (operation: TradeOperationType, startTime: number, message: string, metadata?: Record<string, any>) =>
        globalLogger.logPerformance(operation, startTime, message, metadata)
}