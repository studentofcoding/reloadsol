import { NextRequest, NextResponse } from 'next/server'

// Store for active SSE connections
interface Connection {
  controller: ReadableStreamDefaultController;
  cleanup: () => void;
  createdAt: number;
  walletAddress: string;
  isActive: boolean;
  keepAliveInterval?: NodeJS.Timeout;
  autoCleanupTimeout?: NodeJS.Timeout;
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

// Helper function to safely enqueue data to controller
function safeEnqueue(controller: ReadableStreamDefaultController, data: Uint8Array, connectionId: string): boolean {
  try {
    // Check if controller is still writable
    if (controller.desiredSize === null) {
      console.log(`Controller already closed for connection: ${connectionId}`)
      return false
    }
    
    controller.enqueue(data)
    return true
  } catch (error) {
    console.error(`Error enqueuing data for connection ${connectionId}:`, error)
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

  // Create Server-Sent Events stream
  const stream = new ReadableStream({
    start(controller) {
      const connectionId = `${walletAddress}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      let connection: Connection
      
      // Send initial connection message
      const initialData = `data: ${JSON.stringify({ 
        type: 'connected', 
        wallet: walletAddress,
        timestamp: new Date().toISOString()
      })}\n\n`
      
      if (!safeEnqueue(controller, new TextEncoder().encode(initialData), connectionId)) {
        console.error('Failed to send initial SSE message')
        return
      }

      // Clean up function
      const cleanup = () => {
        console.log(`🧹 Cleaning up SSE connection: ${connectionId}`)
        
        if (connection) {
          connection.isActive = false
          
          // Clear intervals and timeouts
          if (connection.keepAliveInterval) {
            clearInterval(connection.keepAliveInterval)
            connection.keepAliveInterval = undefined
          }
          
          if (connection.autoCleanupTimeout) {
            clearTimeout(connection.autoCleanupTimeout)
            connection.autoCleanupTimeout = undefined
          }
        }
        
        // Remove from active connections
        activeConnections.delete(connectionId)
        
        // Close controller if still open
        try {
          if (controller.desiredSize !== null) {
            controller.close()
          }
        } catch (error) {
          // Controller already closed or in error state
          console.log(`Controller cleanup completed for ${connectionId}`)
        }
      }

      // Create connection object
      connection = {
        controller,
        cleanup,
        createdAt: Date.now(),
        walletAddress,
        isActive: true
      }

      // Store connection
      activeConnections.set(connectionId, connection)

      // Send keepalive every 30 seconds
      connection.keepAliveInterval = setInterval(() => {
        // Double-check connection is still active
        if (!connection.isActive || !activeConnections.has(connectionId)) {
          if (connection.keepAliveInterval) {
            clearInterval(connection.keepAliveInterval)
            connection.keepAliveInterval = undefined
          }
          return
        }
        
        const keepAliveData = `data: ${JSON.stringify({ 
          type: 'keepalive',
          timestamp: new Date().toISOString()
        })}\n\n`
        
        if (!safeEnqueue(controller, new TextEncoder().encode(keepAliveData), connectionId)) {
          console.log(`Keepalive failed for ${connectionId}, cleaning up connection`)
          cleanup()
        }
      }, 30000)

      // Auto cleanup after 5 minutes
      connection.autoCleanupTimeout = setTimeout(() => {
        console.log(`⏰ Auto-cleaning SSE connection: ${connectionId}`)
        cleanup()
      }, 5 * 60 * 1000)
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
      if (connection.walletAddress === walletAddress && connection.isActive) {
        const message = `data: ${JSON.stringify({
          type,
          data,
          timestamp: new Date().toISOString()
        })}\n\n`

        if (safeEnqueue(connection.controller, new TextEncoder().encode(message), connectionId)) {
          notifiedCount++
        } else {
          // Connection is dead, mark for cleanup
          console.log(`Connection ${connectionId} is dead, marking for cleanup`)
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