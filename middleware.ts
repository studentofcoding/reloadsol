import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Clone the request headers
  const requestHeaders = new Headers(request.headers)
  
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
  
  if (forwarded && !requestHeaders.has('x-forwarded-host')) {
    const host = requestHeaders.get('host')
    if (host) {
      requestHeaders.set('x-forwarded-host', host)
    }
  }

  // Create response with updated headers
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })

  // Add CORS headers for API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('Access-Control-Allow-Origin', '*')
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Origin')
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}