import { NextRequest, NextResponse } from 'next/server'

// Store for active SSE connections
interface Connection {
  controller: ReadableStreamDefaultController;
  cleanup: () => void;
  createdAt: number;
}
const activeConnections = new Map<string, Connection>()

// Add periodic cleanup of stale connections
setInterval(() => {
  const now = Date.now()
  for (const [id, conn] of Array.from(activeConnections.entries())) {
    if (now - conn.createdAt > 5 * 60 * 1000) {
      conn.cleanup()
      activeConnections.delete(id)
    }
  }
}, 60000)
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

  // Create Server-Sent Events stream
  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection message
      const data = `data: ${JSON.stringify({ type: 'connected', wallet: walletAddress })}\n\n`
      controller.enqueue(new TextEncoder().encode(data))

      // Store connection for notifications
      const connectionId = `${walletAddress}-${Date.now()}`
      
      // Clean up on close
      const cleanup = () => {
        activeConnections.delete(connectionId)
        controller.close()
      }

      // Store cleanup function
      activeConnections.set(connectionId, {
        controller,
        cleanup,
        createdAt: Date.now()
      })

      // Send keepalive every 30 seconds
      const keepAlive = setInterval(() => {
        try {
          const keepAliveData = `data: ${JSON.stringify({ type: 'keepalive' })}\n\n`
          controller.enqueue(new TextEncoder().encode(keepAliveData))
        } catch (error) {
          cleanup()
          clearInterval(keepAlive)
        }
      }, 30000)

      // Auto cleanup after 5 minutes
      setTimeout(() => {
        cleanup()
        clearInterval(keepAlive)
      }, 5 * 60 * 1000)
    },
    cancel() {
      // Connection closed by client
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control',
    },
  })
}

// POST /api/trading/subscribe - Notify all subscribers of updates
export async function POST(request: NextRequest) {
  try {
    const { walletAddress, record } = await request.json()

    if (!walletAddress || !record) {
      return NextResponse.json(
        { error: 'walletAddress and record are required' },
        { status: 400 }
      )
    }

    // Notify all active connections for this wallet
    let notifiedCount = 0
    for (const [connectionId, cleanup] of Array.from(activeConnections.entries())) {
      if (connectionId.startsWith(walletAddress)) {
        try {
          // This would need a proper implementation with stored controller references
          // For now, we'll use a simpler polling approach in the client
          notifiedCount++
        } catch (error) {
          // Connection is dead, clean it up
          activeConnections.delete(connectionId)
        }
      }
    }

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