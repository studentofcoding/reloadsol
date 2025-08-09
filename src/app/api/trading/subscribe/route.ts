import { NextRequest, NextResponse } from 'next/server'

// Store for active SSE connections
interface Connection {
  controller: ReadableStreamDefaultController;
  walletAddress: string;
  createdAt: number;
  keepAliveInterval?: NodeJS.Timeout;
}

const activeConnections = new Map<string, Connection>()

// Simple cleanup of old connections every minute
setInterval(() => {
  const now = Date.now()
  const toDelete: string[] = []

  for (const [id, conn] of Array.from(activeConnections.entries())) {
    // Clean up connections older than 5 minutes
    if (now - conn.createdAt > 5 * 60 * 1000) {
      console.log(`🧹 Cleaning up old connection: ${id}`)
      if (conn.keepAliveInterval) {
        clearInterval(conn.keepAliveInterval)
      }
      toDelete.push(id)
    }
  }

  toDelete.forEach(id => activeConnections.delete(id))
}, 60000)

// Simple enqueue function - just try and clean up on failure
function safeEnqueue(connectionId: string, data: Uint8Array): boolean {
  const connection = activeConnections.get(connectionId)
  if (!connection) {
    return false
  }

  try {
    connection.controller.enqueue(data)
    return true
  } catch (error: unknown) {
    // Any error means the connection is dead - clean it up immediately
    console.log(`Connection ${connectionId} failed, cleaning up:`, (error as Error).message)

    if (connection.keepAliveInterval) {
      clearInterval(connection.keepAliveInterval)
    }

    activeConnections.delete(connectionId)
    return false
  }
}

// GET /api/trading/subscribe?wallet=<address>
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const walletAddress = searchParams.get('wallet')

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

  const stream = new ReadableStream({
    start(controller) {
      const connectionId = `${walletAddress}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

      // Create simple connection object
      const connection: Connection = {
        controller,
        walletAddress,
        createdAt: Date.now()
      }

      // Store connection
      activeConnections.set(connectionId, connection)

      // Send initial message
      const initialData = `data: ${JSON.stringify({
        type: 'connected',
        wallet: walletAddress,
        timestamp: new Date().toISOString()
      })}\n\n`

      if (!safeEnqueue(connectionId, new TextEncoder().encode(initialData))) {
        console.error('Failed to send initial SSE message')
        return
      }

      // Simple keepalive every 30 seconds
      connection.keepAliveInterval = setInterval(() => {
        const keepAliveData = `data: ${JSON.stringify({
          type: 'keepalive',
          timestamp: new Date().toISOString()
        })}\n\n`

        // If keepalive fails, the connection is automatically cleaned up by safeEnqueue
        safeEnqueue(connectionId, new TextEncoder().encode(keepAliveData))
      }, 30000)
    },

    cancel() {
      // Find and clean up connection for this wallet
      for (const [id, conn] of Array.from(activeConnections.entries())) {
        if (conn.walletAddress === walletAddress) {
          console.log(`Client cancelled connection: ${id}`)
          if (conn.keepAliveInterval) {
            clearInterval(conn.keepAliveInterval)
          }
          activeConnections.delete(id)
          break
        }
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': process.env.NODE_ENV === 'development' ? '*' : 'https://v2.reloadsol.xyz',
      'Access-Control-Allow-Headers': 'Cache-Control',
      'X-Accel-Buffering': 'no',
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

    // Find all connections for this wallet and try to notify them
    for (const [connectionId, connection] of Array.from(activeConnections.entries())) {
      if (connection.walletAddress === walletAddress) {
        const message = `data: ${JSON.stringify({
          type,
          data,
          timestamp: new Date().toISOString()
        })}\n\n`

        if (safeEnqueue(connectionId, new TextEncoder().encode(message))) {
          notifiedCount++
        }
        // Dead connections are automatically cleaned up by safeEnqueue
      }
    }

    console.log(`📡 Notified ${notifiedCount} connections for wallet ${walletAddress.slice(0, 8)}...`)

    return NextResponse.json({
      success: true,
      notified: notifiedCount
    })
  } catch (error) {
    console.error('Error notifying subscribers:', error)
    return NextResponse.json(
      { error: 'Failed to notify subscribers' },
      { status: 500 }
    )
  }
}