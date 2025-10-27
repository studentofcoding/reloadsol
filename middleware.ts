import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Base allowed origins (exact matches)
  const baseAllowedOrigins = [
    'https://reloadsol.xyz',
    'https://v2.reloadsol.xyz',
    'https://testing.reloadsol.xyz',
  ]

  // Helper: Determine if origin is allowed (any https subdomain of reloadsol.xyz)
  const isAllowedOrigin = (origin: string | null): boolean => {
    if (!origin) return false
    try {
      const url = new URL(origin)
      const hostname = url.hostname
      const protocol = url.protocol

      // Only allow https in production
      if (process.env.NODE_ENV === 'production' && protocol !== 'https:') return false

      // Allow apex domain and any subdomain of reloadsol.xyz
      if (hostname === 'reloadsol.xyz' || hostname.endsWith('.reloadsol.xyz')) return true

      // Allow exact matches from base list (covers specific non-standard cases)
      if (baseAllowedOrigins.includes(origin)) return true

      // Allow localhost in non-production
      if (
        process.env.NODE_ENV !== 'production' &&
        (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))
      ) {
        return true
      }

      return false
    } catch {
      return false
    }
  }

  const origin = request.headers.get('origin')

  // Clone the request headers
  const requestHeaders = new Headers(request.headers)

  // Build response with modified request headers (ensures we return the same response we mutate)
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })

  // Handle CORS for API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    // Set CORS headers if origin is allowed
    if (isAllowedOrigin(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin as string)
    }

    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Origin')
    response.headers.set('Access-Control-Max-Age', '86400') // 24 hours

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      const preflightHeaders = new Headers(response.headers)
      return new Response(null, { status: 200, headers: preflightHeaders })
    }
  }
  
  // Add origin header if missing (for Server Actions)
  if (!requestHeaders.has('origin')) {
    const host = requestHeaders.get('host')
    const protocol = request.nextUrl.protocol
    
    if (host) {
      requestHeaders.set('origin', `${protocol}//${host}`)
    }
  }

  // Add forwarded headers for PM2/proxy setups
  const forwarded = requestHeaders.get('x-forwarded-for')
  const realIp = requestHeaders.get('x-real-ip')
  
  if (forwarded && !requestHeaders.has('x-forwarded-for')) {
    requestHeaders.set('x-forwarded-for', forwarded)
  }
  
  if (realIp && !requestHeaders.has('x-real-ip')) {
    requestHeaders.set('x-real-ip', realIp)
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}