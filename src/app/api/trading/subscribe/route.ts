import { NextRequest, NextResponse } from 'next/server'

// Store for active SSE connections
interface Connection {
  controller: ReadableStreamDefaultController;
  walletAddress: string;
  createdAt: number;
  keepAliveInterval?: NodeJS.Timeout;
  connectionId: string;
  isActive: boolean;
}

const activeConnections = new Map<string, Connection>()

// Enhanced cleanup of old connections every minute
setInterval(() => {
  const now = Date.now()
  const toDelete: string[] = []

  for (const [id, conn] of Array.from(activeConnections.entries())) {
    // ✅ NEW: More aggressive cleanup - 2 minutes instead of 5
    if (now - conn.createdAt > 2 * 60 * 1000 || !conn.isActive) {
      console.log(`🧹 Cleaning up connection: ${id} (age: ${Math.round((now - conn.createdAt) / 1000)}s, active: ${conn.isActive})`)
      cleanupConnection(id)
      toDelete.push(id)
    }
  }

  toDelete.forEach(id => activeConnections.delete(id))
}, 30000) // ✅ NEW: Run cleanup every 30 seconds instead of 60

// Enhanced cleanup function
function cleanupConnection(connectionId: string): void {
  const connection = activeConnections.get(connectionId)
  if (!connection) return

  try {
    // Clear keepalive interval
    if (connection.keepAliveInterval) {
      clearInterval(connection.keepAliveInterval)
    }

    // Mark as inactive
    connection.isActive = false

    // Try to close the controller gracefully
    if (connection.controller) {
      try {
        connection.controller.close()
      } catch (error) {
        // Controller might already be closed
        console.log(`Controller already closed for ${connectionId}`)
      }
    }
  } catch (error) {
    console.error(`Error cleaning up connection ${connectionId}:`, error)
  }
}

// Enhanced enqueue function with better error handling
// In safeEnqueue function, around line 61
function safeEnqueue(connectionId: string, data: Uint8Array): boolean {
  const connection = activeConnections.get(connectionId)
  if (!connection || !connection.isActive) {
    console.log(`⚠️ Connection ${connectionId} not found or inactive`)
    return false
  }

  try {
    connection.controller.enqueue(data)
    return true
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.log(`❌ Connection ${connectionId} failed, cleaning up: ${errorMessage}`)

    // ✅ Enhanced error logging for debugging
    console.log(`❌ Controller state:`, {
      connectionId,
      isActive: connection.isActive,
      createdAt: connection.createdAt,
      age: Date.now() - connection.createdAt,
      errorType: error instanceof Error ? error.constructor.name : typeof error
    })

    // Mark as inactive and clean up
    connection.isActive = false
    cleanupConnection(connectionId)
    activeConnections.delete(connectionId)
    return false
  }
}

// GET /api/trading/subscribe?wallet=<address>
// In the GET function, around line 100
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const walletAddress = searchParams.get('wallet')
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

  console.log(`📡 [${requestId}] New SSE connection request for wallet: ${walletAddress?.slice(0, 8)}...`)
  console.log(`📡 [${requestId}] Request headers:`, {
    userAgent: request.headers.get('user-agent'),
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    connection: request.headers.get('connection'),
    cacheControl: request.headers.get('cache-control')
  })
  console.log(`📡 [${requestId}] Active connections before cleanup: ${activeConnections.size}`)

  if (!walletAddress) {
    return NextResponse.json(
      { error: 'wallet parameter is required' },
      { status: 400 }
    )
  }

  // Validate wallet address format
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return NextResponse.json(
      { error: 'Invalid wallet address format' },
      { status: 400 }
    )
  }

  console.log(`📡 New SSE connection for wallet: ${walletAddress.slice(0, 8)}...`)

  // ✅ NEW: Enhanced cleanup with delay to prevent race conditions
  const connectionsToCleanup: string[] = []
  for (const [id, conn] of Array.from(activeConnections.entries())) {
    if (conn.walletAddress === walletAddress) {
      console.log(`🔄 Cleaning up existing connection for wallet: ${id}`)
      connectionsToCleanup.push(id)
    }
  }

  // Clean up existing connections
  connectionsToCleanup.forEach(id => {
    cleanupConnection(id)
    activeConnections.delete(id)
  })

  // ✅ NEW: Small delay to ensure cleanup completes
  await new Promise(resolve => setTimeout(resolve, 100))

  const stream = new ReadableStream({
    start(controller) {
      const connectionId = `${walletAddress}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      console.log(`✅ [${requestId}] Creating connection: ${connectionId}`)

      // Create enhanced connection object
      const connection: Connection = {
        controller,
        walletAddress,
        createdAt: Date.now(),
        connectionId,
        isActive: true
      }

      // Store connection
      activeConnections.set(connectionId, connection)

      // Send initial connection message with proper SSE format
      // Enhanced initial message logging
      const initialData = `id: ${connectionId}\ndata: ${JSON.stringify({
        type: 'connected',
        wallet: walletAddress,
        connectionId,
        timestamp: new Date().toISOString()
      })}\n\n`

      if (!safeEnqueue(connectionId, new TextEncoder().encode(initialData))) {
        console.error(`❌ [${requestId}] Failed to send initial SSE message for ${connectionId}`)
        return
      }
      console.log(`✅ [${requestId}] Initial message sent for ${connectionId}`)
    },

    cancel() {
      console.log(`🔌 [${requestId}] Client cancelled connection for wallet: ${walletAddress?.slice(0, 8)}...`)
      // Find and clean up connection for this wallet
      for (const [id, conn] of Array.from(activeConnections.entries())) {
        if (conn.walletAddress === walletAddress) {
          console.log(`Client cancelled connection: ${id}`)
          cleanupConnection(id)
          activeConnections.delete(id)
          break
        }
      }
    }
  })

  console.log(`📡 [${requestId}] SSE stream created successfully`)
  // Resolve allowed origin (echo allowed reloadsol.xyz subdomain)
  const origin = request.headers.get('origin')
  let allowedOrigin: string | null = null
  if (origin) {
    try {
      const url = new URL(origin)
      const hostname = url.hostname
      const protocol = url.protocol
      if (process.env.NODE_ENV !== 'production' || protocol === 'https:') {
        if (hostname === 'reloadsol.xyz' || hostname.endsWith('.reloadsol.xyz')) {
          allowedOrigin = origin
        }
      }
      if (!allowedOrigin && process.env.NODE_ENV !== 'production') {
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
          allowedOrigin = origin
        }
      }
    } catch {}
  }

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
      'Access-Control-Allow-Headers': 'Cache-Control',
      'X-Accel-Buffering': 'no',
      // Additional headers for better streaming support
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  })
}

// POST /api/trading/subscribe - Notify all subscribers
export async function POST(request: NextRequest) {
  try {
    const { walletAddress, type, data } = await request.json()

    if (!walletAddress || !type) {
      return NextResponse.json(
        { error: 'walletAddress and type are required' },
        { status: 400 }
      )
    }

    let notifiedCount = 0
    const failedConnections: string[] = []

    // Find all active connections for this wallet and try to notify them
    for (const [connectionId, connection] of Array.from(activeConnections.entries())) {
      if (connection.walletAddress === walletAddress && connection.isActive) {
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`
        const message = `id: ${messageId}\ndata: ${JSON.stringify({
          type,
          data,
          connectionId: connection.connectionId,
          timestamp: new Date().toISOString()
        })}\n\n`

        if (safeEnqueue(connectionId, new TextEncoder().encode(message))) {
          notifiedCount++
        } else {
          failedConnections.push(connectionId)
        }
      }
    }

    // Clean up failed connections
    failedConnections.forEach(id => {
      cleanupConnection(id)
      activeConnections.delete(id)
    })

    console.log(`📡 Notified ${notifiedCount} connections for wallet ${walletAddress.slice(0, 8)}... (${failedConnections.length} failed)`)

    // Resolve allowed origin for CORS
    const origin = request.headers.get('origin')
    let allowedOrigin: string | null = null
    if (origin) {
      try {
        const url = new URL(origin)
        const hostname = url.hostname
        const protocol = url.protocol
        if (process.env.NODE_ENV !== 'production' || protocol === 'https:') {
          if (hostname === 'reloadsol.xyz' || hostname.endsWith('.reloadsol.xyz')) {
            allowedOrigin = origin
          }
        }
        if (!allowedOrigin && process.env.NODE_ENV !== 'production') {
          if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
            allowedOrigin = origin
          }
        }
      } catch {}
    }

    return NextResponse.json(
      {
        success: true,
        notified: notifiedCount,
        failed: failedConnections.length,
        activeConnections: activeConnections.size
      },
      {
        headers: {
          ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin',
        },
      }
    )
  } catch (error) {
    console.error('Error notifying subscribers:', error)
    return NextResponse.json(
      { error: 'Failed to notify subscribers' },
      { status: 500 }
    )
  }
}