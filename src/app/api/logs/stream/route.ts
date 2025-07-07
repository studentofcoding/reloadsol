import { NextRequest } from 'next/server'
import { getLogs } from '@/utils/api-logger'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const level = searchParams.get('level')
  const endpoint = searchParams.get('endpoint')

  // Create readable stream for Server-Sent Events
  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection message
      controller.enqueue(`data: ${JSON.stringify({
        type: 'connected',
        message: 'Connected to log stream',
        timestamp: new Date().toISOString()
      })}\n\n`)

      let lastLogCount = 0

      // Poll for new logs every 1 second
      const interval = setInterval(() => {
        try {
          const logs = getLogs({
            level: level as any,
            endpoint: endpoint || undefined,
            limit: 50 // Last 50 logs
          })

          // Check if we have new logs
          if (logs.length > lastLogCount) {
            const newLogs = logs.slice(0, logs.length - lastLogCount)
            
            newLogs.forEach(log => {
              const data = {
                type: 'log',
                log,
                timestamp: new Date().toISOString()
              }
              
              controller.enqueue(`data: ${JSON.stringify(data)}\n\n`)
            })
            
            lastLogCount = logs.length
          }

          // Send heartbeat every 30 seconds
          if (Date.now() % 30000 < 1000) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'heartbeat',
              timestamp: new Date().toISOString()
            })}\n\n`)
          }
        } catch (error) {
          console.error('Log stream error:', error)
          controller.enqueue(`data: ${JSON.stringify({
            type: 'error',
            message: 'Stream error occurred',
            timestamp: new Date().toISOString()
          })}\n\n`)
        }
      }, 1000)

      // Cleanup on close
      const cleanup = () => {
        clearInterval(interval)
      }

      // Handle client disconnect
      request.signal.addEventListener('abort', cleanup)

      // Auto-cleanup after 5 minutes
      setTimeout(() => {
        cleanup()
        controller.close()
      }, 5 * 60 * 1000)
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    }
  })
} 