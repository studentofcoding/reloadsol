import { NextRequest, NextResponse } from 'next/server'

// Store for active SSE connections
interface Connection {
  controller: ReadableStreamDefaultController;
  cleanup: () => void;
  createdAt: number;
  walletAddress: string;
}
const activeConnections = new Map<string, Connection>()

// Add periodic cleanup of stale connections
setInterval(() => {
  const now = Date.now()
  for (const [id, conn] of Array.from(activeConnections.entries())) {
    if (now - conn.createdAt > 5 * 60 * 1000) {
      console.log(`🧹 Cleaning up stale SSE connection: ${id}`)
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

  // Validate wallet address format
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
    return NextResponse.json(
      { error: 'Invalid wallet address format' },
      { status: 400 }
    )
  }

  console.log(`📡 New SSE connection for wallet: ${walletAddress.slice(0, 8)}...`)

  // Create Server-Sent Events stream
  const stream = new ReadableStream({
    start(controller) {
      let isActive = true
      
      // Send initial connection message
      try {
        const data = `data: ${JSON.stringify({ 
          type: 'connected', 
          wallet: walletAddress,
          timestamp: new Date().toISOString()
        })}\n\n`
        controller.enqueue(new TextEncoder().encode(data))
      } catch (error) {
        console.error('Error sending initial SSE message:', error)
        isActive = false
        return
      }

      // Store connection for notifications
      const connectionId = `${walletAddress}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

      // Clean up on close
      const cleanup = () => {
        isActive = false
        activeConnections.delete(connectionId)
        try {
          if (!controller.desiredSize === null) {
            controller.close()
          }
        } catch (error) {
          // Controller already closed
        }
      }

      // Store connection with controller reference
      activeConnections.set(connectionId, {
        controller,
        cleanup,
        createdAt: Date.now(),
        walletAddress
      })

      // Send keepalive every 30 seconds
      const keepAlive = setInterval(() => {
        if (!isActive) {
          clearInterval(keepAlive)
          return
        }
        
        try {
          const keepAliveData = `data: ${JSON.stringify({ 
            type: 'keepalive',
            timestamp: new Date().toISOString()
          })}\n\n`
          controller.enqueue(new TextEncoder().encode(keepAliveData))
        } catch (error) {
          console.error('Error sending keepalive:', error)
          cleanup()
          clearInterval(keepAlive)
        }
      }, 30000)

      // Auto cleanup after 5 minutes
      const autoCleanup = setTimeout(() => {
        console.log(`⏰ Auto-cleaning SSE connection: ${connectionId}`)
        cleanup()
        clearInterval(keepAlive)
      }, 5 * 60 * 1000)

      // Store cleanup references
      const originalCleanup = cleanup
      activeConnections.get(connectionId)!.cleanup = () => {
        clearInterval(keepAlive)
        clearTimeout(autoCleanup)
        originalCleanup()
      }
    },
    cancel() {
      // Connection closed by client
      console.log('SSE connection cancelled by client')
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': process.env.NODE_ENV === 'development' ? '*' : 'https://v2.reloadsol.xyz',
      'Access-Control-Allow-Headers': 'Cache-Control',
      'X-Accel-Buffering': 'no', // Disable nginx buffering for SSE
    },
  })
}

// POST /api/trading/subscribe - Notify all subscribers of updates
export async function POST(request: NextRequest) {
  try {
    const { walletAddress, type, data } = await request.json()

    if (!walletAddress || !type) {
      return NextResponse.json(
        { error: 'walletAddress and type are required' },
        { status: 400 }
      )
    }

    // Notify all active connections for this wallet
    let notifiedCount = 0
    const deadConnections: string[] = []

    for (const [connectionId, connection] of Array.from(activeConnections.entries())) {
      if (connection.walletAddress === walletAddress) {
        try {
          const message = `data: ${JSON.stringify({
            type,
            data,
            timestamp: new Date().toISOString()
          })}\n\n`

          connection.controller.enqueue(new TextEncoder().encode(message))
          notifiedCount++
        } catch (error) {
          console.error(`Error notifying connection ${connectionId}:`, error)
          // Connection is dead, mark for cleanup
          deadConnections.push(connectionId)
          connection.cleanup()
        }
      }
    }

    // Clean up dead connections
    deadConnections.forEach(id => activeConnections.delete(id))

    console.log(`📡 Notified ${notifiedCount} connections for wallet ${walletAddress.slice(0, 8)}...`)

    return NextResponse.json({
      success: true,
      notified: notifiedCount,
      cleaned: deadConnections.length
    })
  } catch (error) {
    console.error('Error notifying subscribers:', error)
    return NextResponse.json(
      { error: 'Failed to notify subscribers' },
      { status: 500 }
    )
  }
}