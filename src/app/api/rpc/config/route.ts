import { NextResponse } from 'next/server'
import { getRpcProviderType, resolveRpcUrls } from '@/utils/rpc-urls'

// Sanitize URLs for public display (remove API keys)
const sanitizeUrl = (url: string): string => {
  try {
    const urlObj = new URL(url)
    // Remove API key parameters
    urlObj.searchParams.delete('api-key')
    urlObj.searchParams.delete('api_key')
    urlObj.searchParams.delete('token')

    // Show just the base URL
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname !== '/' ? urlObj.pathname : ''}${urlObj.search ? '?***' : ''}`
  } catch {
    return 'Invalid URL'
  }
}

export async function GET() {
  try {
    const rpcUrls = resolveRpcUrls()
    if (rpcUrls.length === 0) {
      return NextResponse.json(
        {
          status: 'error',
          error: 'RPC not configured. Set RPC_URL or SHYFT_API_KEY in .env',
        },
        { status: 503 },
      )
    }

    return NextResponse.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      configuration: {
        total_endpoints: rpcUrls.length,
        endpoints: rpcUrls.map((url, index) => ({
          index: index + 1,
          url: sanitizeUrl(url),
          type: getRpcProviderType(url)
        })),
        proxy_available: true,
        health_check_available: true
      },
      usage: {
        server_side: 'Direct connection to configured endpoints',
        client_side: 'All requests proxied through /api/rpc',
        health_monitoring: 'Available at /api/rpc/health'
      }
    })

  } catch (error) {
    console.error('RPC config error:', error)
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
} 