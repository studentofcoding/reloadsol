import { NextRequest, NextResponse } from 'next/server'
import { formatAppDateTime } from '@/utils/datetime'

// Log levels
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical'

// Request metadata interface
interface RequestMetadata {
  requestId: string
  method: string
  path: string
  userAgent?: string
  ip?: string
  referer?: string
  contentLength?: number
  timestamp: string
}

// Response metadata interface
interface ResponseMetadata {
  statusCode: number
  contentLength?: number
  responseTime: number
  headers?: Record<string, string>
}

// API log entry interface
interface ApiLogEntry {
  requestId: string
  level: LogLevel
  endpoint: string
  method: string
  message: string
  timestamp: string
  duration?: number
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
  error?: {
    message: string
    stack?: string
    code?: string
  }
  metadata?: Record<string, any>
}

// In-memory log storage (for development/demo purposes)
// In production, you'd want to use a proper logging service
const logBuffer: ApiLogEntry[] = []
const MAX_LOG_ENTRIES = 1000 // Keep last 1000 entries in memory

// Color codes for console output
const colors = {
  debug: '\x1b[36m',   // Cyan
  info: '\x1b[32m',    // Green
  warn: '\x1b[33m',    // Yellow
  error: '\x1b[31m',   // Red
  critical: '\x1b[35m', // Magenta
  reset: '\x1b[0m'
}

// Generate unique request ID
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

// Extract request metadata
function extractRequestMetadata(request: NextRequest): RequestMetadata {
  const url = new URL(request.url)
  
  return {
    requestId: generateRequestId(),
    method: request.method,
    path: url.pathname,
    userAgent: request.headers.get('user-agent') || undefined,
    ip: request.headers.get('x-forwarded-for') || 
        request.headers.get('x-real-ip') || 
        'unknown',
    referer: request.headers.get('referer') || undefined,
    contentLength: request.headers.get('content-length') ? 
      parseInt(request.headers.get('content-length')!) : undefined,
    timestamp: new Date().toISOString()
  }
}

// Core logging function
function writeLog(entry: ApiLogEntry): void {
  // Add to buffer
  logBuffer.push(entry)
  
  // Trim buffer if needed
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES)
  }
  
  // Console output with colors
  const color = colors[entry.level] || colors.reset
  const resetColor = colors.reset
  
  const prefix = `${color}[${entry.level.toUpperCase()}]${resetColor}`
  const timestamp = `[${formatAppDateTime(entry.timestamp)}]`
  const requestInfo = `[${entry.method} ${entry.endpoint}]`
  const duration = entry.duration ? `[${entry.duration}ms]` : ''
  const status = entry.response?.statusCode ? `[${entry.response.statusCode}]` : ''
  
  console.log(`${prefix} ${timestamp} ${requestInfo} ${status} ${duration} - ${entry.message}`)
  
  // Log additional details for errors
  if (entry.level === 'error' || entry.level === 'critical') {
    if (entry.error) {
      console.error(`  Error: ${entry.error.message}`)
      if (entry.error.stack && process.env.NODE_ENV === 'development') {
        console.error(`  Stack: ${entry.error.stack}`)
      }
    }
    if (entry.metadata) {
      console.error(`  Metadata:`, entry.metadata)
    }
  }
}

// Logger class
export class ApiLogger {
  private requestMetadata: RequestMetadata

  constructor(request: NextRequest) {
    this.requestMetadata = extractRequestMetadata(request)
  }

  // Get request ID
  getRequestId(): string {
    return this.requestMetadata.requestId
  }

  // Get request metadata
  getRequestMetadata(): RequestMetadata {
    return this.requestMetadata
  }

  // Log methods
  debug(message: string, metadata?: Record<string, any>): void {
    this.log('debug', message, metadata)
  }

  info(message: string, metadata?: Record<string, any>): void {
    this.log('info', message, metadata)
  }

  warn(message: string, metadata?: Record<string, any>): void {
    this.log('warn', message, metadata)
  }

  error(message: string, error?: Error, metadata?: Record<string, any>): void {
    this.log('error', message, metadata, error)
  }

  critical(message: string, error?: Error, metadata?: Record<string, any>): void {
    this.log('critical', message, metadata, error)
  }

  // Core log method
  private log(level: LogLevel, message: string, metadata?: Record<string, any>, error?: Error): void {
    const entry: ApiLogEntry = {
      requestId: this.requestMetadata.requestId,
      level,
      endpoint: this.requestMetadata.path,
      method: this.requestMetadata.method,
      message,
      timestamp: new Date().toISOString(),
      request: {
        path: this.requestMetadata.path,
        userAgent: this.requestMetadata.userAgent,
        ip: this.requestMetadata.ip,
        contentLength: this.requestMetadata.contentLength
      },
      metadata,
      error: error ? {
        message: error.message,
        stack: error.stack,
        code: (error as any).code
      } : undefined
    }

    writeLog(entry)
  }

  // Log request start
  logRequestStart(metadata?: Record<string, any>): void {
    this.info(`Request started`, {
      userAgent: this.requestMetadata.userAgent,
      ip: this.requestMetadata.ip,
      ...metadata
    })
  }

  // Log response
  logResponse(response: NextResponse | Response, startTime: number, metadata?: Record<string, any>): void {
    const duration = Date.now() - startTime
    const statusCode = response.status
    
    const entry: ApiLogEntry = {
      requestId: this.requestMetadata.requestId,
      level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
      endpoint: this.requestMetadata.path,
      method: this.requestMetadata.method,
      message: `Request completed`,
      timestamp: new Date().toISOString(),
      duration,
      request: {
        path: this.requestMetadata.path,
        userAgent: this.requestMetadata.userAgent,
        ip: this.requestMetadata.ip,
        contentLength: this.requestMetadata.contentLength
      },
      response: {
        statusCode,
        contentLength: response.headers.get('content-length') ? 
          parseInt(response.headers.get('content-length')!) : undefined,
        headers: {
          'content-type': response.headers.get('content-type') || '',
          'cache-control': response.headers.get('cache-control') || ''
        }
      },
      metadata
    }

    writeLog(entry)
  }
}

// Utility functions for log retrieval and filtering
export function getLogs(options?: {
  level?: LogLevel
  endpoint?: string
  method?: string
  limit?: number
  since?: string
}): ApiLogEntry[] {
  let filtered = [...logBuffer]

  if (options?.level) {
    filtered = filtered.filter(log => log.level === options.level)
  }

  if (options?.endpoint) {
    filtered = filtered.filter(log => log.endpoint.includes(options.endpoint!))
  }

  if (options?.method) {
    filtered = filtered.filter(log => log.method === options.method)
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

// Get real-time stats
export function getLogStats(): {
  totalLogs: number
  logsByLevel: Record<LogLevel, number>
  logsByEndpoint: Record<string, number>
  logsByMethod: Record<string, number>
  averageResponseTime: number
  errorRate: number
} {
  const stats = {
    totalLogs: logBuffer.length,
    logsByLevel: {} as Record<LogLevel, number>,
    logsByEndpoint: {} as Record<string, number>,
    logsByMethod: {} as Record<string, number>,
    averageResponseTime: 0,
    errorRate: 0
  }

  // Initialize counters
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'critical']
  levels.forEach(level => stats.logsByLevel[level] = 0)

  let totalDuration = 0
  let responseCount = 0
  let errorCount = 0

  logBuffer.forEach(log => {
    // Count by level
    stats.logsByLevel[log.level]++

    // Count by endpoint
    stats.logsByEndpoint[log.endpoint] = (stats.logsByEndpoint[log.endpoint] || 0) + 1

    // Count by method
    stats.logsByMethod[log.method] = (stats.logsByMethod[log.method] || 0) + 1

    // Calculate average response time
    if (log.duration) {
      totalDuration += log.duration
      responseCount++
    }

    // Count errors
    if (log.level === 'error' || log.level === 'critical') {
      errorCount++
    }
  })

  stats.averageResponseTime = responseCount > 0 ? Math.round(totalDuration / responseCount) : 0
  stats.errorRate = logBuffer.length > 0 ? Math.round((errorCount / logBuffer.length) * 100) : 0

  return stats
}

// Clear logs (useful for testing)
export function clearLogs(): void {
  logBuffer.length = 0
} 