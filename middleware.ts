import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Define allowed origins
  const allowedOrigins = [
    'https://v2.reloadsol.xyz',
    'https://testing.reloadsol.xyz',
    ...(process.env.NODE_ENV !== 'production' ? [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://localhost:4000',
      'http://localhost:4001',
      'http://127.0.0.1:4000',
      'http://127.0.0.1:4001'
    ] : [])
  ];

  const origin = request.headers.get('origin');
  const response = NextResponse.next();

  // Handle CORS for API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    // Check if origin is allowed
    if (origin && allowedOrigins.includes(origin)) {
      response.headers.set('Access-Control-Allow-Origin', origin);
    }

    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Origin');
    response.headers.set('Access-Control-Max-Age', '86400'); // 24 hours

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: response.headers });
    }
  }

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

  if (forwarded && !requestHeaders.has('x-forwarded-for')) {
    requestHeaders.set('x-forwarded-for', forwarded)
  }

  if (realIp && !requestHeaders.has('x-real-ip')) {
    requestHeaders.set('x-real-ip', realIp)
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}