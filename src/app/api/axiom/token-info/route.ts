import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const pairAddress = searchParams.get('pairAddress')

    if (!pairAddress) {
      return NextResponse.json({
        error: 'Pair address is required',
        example: '/api/axiom/token-info?pairAddress=TOKEN_PAIR_ADDRESS'
      }, { status: 400 })
    }

    // Validate pair address format (basic Solana address validation)
    if (pairAddress.length < 32 || pairAddress.length > 44) {
      return NextResponse.json({
        error: 'Invalid pair address format'
      }, { status: 400 })
    }

    console.log(`🔍 Fetching Axiom token info for: ${pairAddress}`)

    // Fetch from Axiom API with authentication cookies
    const response = await fetch(`https://api.axiom.trade/token-info?pairAddress=${pairAddress}`, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'max-age=0',
        'Connection': 'keep-alive',
        'Cookie': 'auth-refresh-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZWZyZXNoVG9rZW5JZCI6ImQyMjE2ZmNkLTA0MGMtNDU5Yi04NzBmLTllMzE1ZjRhN2JiMiIsImlhdCI6MTc1MDkxODMxOH0.PHzn1ZhMS-5frteZOuJhV5T3zH7eZOas_m4j5xWUSMQ; auth-access-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdXRoZW50aWNhdGVkVXNlcklkIjoiMGU5N2E1MTMtZTU5Ni00ZjFhLWIyNzUtMGMxZDY5MmU5Y2Q0IiwiaWF0IjoxNzUyODAyMTIyLCJleHAiOjE3NTI4MDMwODJ9.hdzuv_XkC2zxLGgusaYwbj16vnaRQR-O-x8dz601pnY',
        'Host': 'api.axiom.trade',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
      },
      // Add timeout
      signal: AbortSignal.timeout(10000) // 10 second timeout
    })

    if (!response.ok) {
      console.error(`Axiom API error: ${response.status} ${response.statusText}`)
      
      // Handle authentication error specifically
      if (response.status === 500) {
        const errorText = await response.text()
        if (errorText.includes('Session invalid') || errorText.includes('login')) {
          return NextResponse.json({
            error: 'Axiom API requires authentication',
            details: 'This API requires login credentials. Please contact support for access.',
            requiresAuth: true
          }, { status: 401 })
        }
      }
      
      return NextResponse.json({
        error: `Axiom API error: ${response.status}`,
        details: response.statusText
      }, { status: response.status })
    }

    const data = await response.json()

    // Check for authentication error in response body
    if (data.error && (data.error.includes('Session invalid') || data.error.includes('login'))) {
      return NextResponse.json({
        error: 'Axiom API requires authentication',
        details: 'This API requires login credentials. Please contact support for access.',
        requiresAuth: true
      }, { status: 401 })
    }

    // Validate required fields
    if (typeof data.numHolders !== 'number' || typeof data.insidersHoldPercent !== 'number' || typeof data.bundlersHoldPercent !== 'number') {
      return NextResponse.json({
        error: 'Invalid response format from Axiom API',
        received: data
      }, { status: 500 })
    }

    console.log(`✅ Successfully fetched Axiom token info for ${pairAddress}`)

    return NextResponse.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=60', // 5 minutes cache
      }
    })

  } catch (error) {
    console.error('❌ Axiom token info API error:', error)
    
    return NextResponse.json({
      error: 'Failed to fetch token info from Axiom',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
} 