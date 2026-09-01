import { NextRequest, NextResponse, connection } from 'next/server'
import { getLogs, getLogStats, clearLogs, LogLevel } from '@/utils/api-logger'
import { formatAppDateTime } from '@/utils/datetime'

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    
    // Parse query parameters
    const level = searchParams.get('level') as LogLevel | null
    const endpoint = searchParams.get('endpoint')
    const method = searchParams.get('method')
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 100
    const since = searchParams.get('since')
    const format = searchParams.get('format') || 'json'
    const stats = searchParams.get('stats') === 'true'

    // Return stats only
    if (stats) {
      const logStats = getLogStats()
      return NextResponse.json({
        success: true,
        stats: logStats,
        timestamp: new Date().toISOString()
      })
    }

    // Get filtered logs
    const logs = getLogs({
      level: level || undefined,
      endpoint: endpoint || undefined,
      method: method || undefined,
      limit,
      since: since || undefined
    })

    // Return plain text format for easy reading
    if (format === 'text') {
      const textOutput = logs.map(log => {
        const timestamp = formatAppDateTime(log.timestamp)
        const duration = log.duration ? `[${log.duration}ms]` : ''
        const status = log.response?.statusCode ? `[${log.response.statusCode}]` : ''
        const error = log.error ? ` ERROR: ${log.error.message}` : ''
        
        return `[${log.level.toUpperCase()}] ${timestamp} [${log.method} ${log.endpoint}] ${status} ${duration} - ${log.message}${error}`
      }).join('\n')

      return new NextResponse(textOutput, {
        headers: {
          'Content-Type': 'text/plain'
        }
      })
    }

    // Return JSON format
    return NextResponse.json({
      success: true,
      filters: {
        level,
        endpoint,
        method,
        limit,
        since
      },
      logs,
      count: logs.length,
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('Logs API error:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve logs' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Simple authentication check
    const { searchParams } = new URL(request.url)
    const clearAuth = searchParams.get('auth')
    const expectedAuth = process.env.LOGS_CLEAR_AUTH || 'clear-logs-secret'

    if (clearAuth !== expectedAuth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    clearLogs()
    
    return NextResponse.json({
      success: true,
      message: 'Logs cleared successfully',
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    console.error('Clear logs error:', error)
    return NextResponse.json(
      { error: 'Failed to clear logs' },
      { status: 500 }
    )
  }
}

// WebSocket-like streaming endpoint for real-time logs (using Server-Sent Events)
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    if (action === 'stream') {
      // Return streaming logs endpoint info
      return NextResponse.json({
        success: true,
        message: 'Use GET /api/logs/stream for real-time log streaming',
        endpoints: {
          realtime: '/api/logs/stream',
          logs: '/api/logs',
          stats: '/api/logs?stats=true',
          text: '/api/logs?format=text'
        }
      })
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    )

  } catch (error) {
    console.error('Logs POST error:', error)
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    )
  }
} 