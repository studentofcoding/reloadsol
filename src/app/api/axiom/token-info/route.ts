import { NextRequest, NextResponse } from 'next/server'

// Force dynamic rendering for this route

// Rate limiting state
interface RateLimitState {
  lastRequestTime: number;
  consecutiveErrors: number;
  backoffUntil: number;
}

// Global rate limit state (persists between requests in development)
let rateLimitState: RateLimitState = {
  lastRequestTime: 0,
  consecutiveErrors: 0,
  backoffUntil: 0
};

// Rate limit configuration
const RATE_LIMIT_CONFIG = {
  minInterval: 1000, // 1 second between requests
  maxBackoff: 60000, // 1 minute max backoff
  timeout: 10000     // 10 second timeout
};

// Helper function to calculate exponential backoff
function calculateBackoff(consecutiveErrors: number, maxBackoff: number): number {
  const baseBackoff = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), maxBackoff);
  // Add some jitter (±10%)
  return baseBackoff * (0.9 + Math.random() * 0.2);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get('pairAddress') // Keep parameter name for backward compatibility

    if (!mintAddress) {
      return NextResponse.json({
        error: 'Mint address is required',
        example: '/api/axiom/token-info?pairAddress=TOKEN_MINT_ADDRESS'
      }, { status: 400 })
    }

    // Validate mint address format (basic Solana address validation)
    if (mintAddress.length < 32 || mintAddress.length > 44) {
      return NextResponse.json({
        error: 'Invalid mint address format'
      }, { status: 400 })
    }

    console.log(`🔍 Fetching Axiom token info for mint: ${mintAddress}`)

    // Check if we're in backoff period
    const now = Date.now();
    if (now < rateLimitState.backoffUntil) {
      console.log(`Axiom API in backoff until ${new Date(rateLimitState.backoffUntil).toISOString()}`);
      return NextResponse.json({
        error: 'Rate limited',
        details: 'Service temporarily unavailable due to rate limiting',
        retryAfter: Math.ceil((rateLimitState.backoffUntil - now) / 1000)
      }, { status: 429 });
    }

    // Enforce minimum interval between requests
    const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT_CONFIG.minInterval) {
      const waitTime = RATE_LIMIT_CONFIG.minInterval - timeSinceLastRequest;
      console.log(`Rate limiting Axiom API, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Update last request time
    rateLimitState.lastRequestTime = Date.now();

    // Fetch from Axiom API with authentication cookies using the graduated pool
    const response = await fetch(`https://api.axiom.trade/token-info?pairAddress=${mintAddress}`, {
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
      signal: AbortSignal.timeout(RATE_LIMIT_CONFIG.timeout)
    })

    // Handle rate limiting from Axiom API
    if (response.status === 429) {
      console.warn('Rate limited by Axiom API');
      rateLimitState.consecutiveErrors++;
      rateLimitState.backoffUntil = Date.now() + calculateBackoff(rateLimitState.consecutiveErrors, RATE_LIMIT_CONFIG.maxBackoff);
      
      return NextResponse.json({
        error: 'Rate limited by upstream API',
        details: 'The Axiom API has rate limited our request',
        retryAfter: Math.ceil(calculateBackoff(rateLimitState.consecutiveErrors, RATE_LIMIT_CONFIG.maxBackoff) / 1000)
      }, { status: 429 });
    }

    if (!response.ok) {
      console.error(`Axiom API error: ${response.status} ${response.statusText}`);
      
      // Increase error count for non-OK responses
      rateLimitState.consecutiveErrors++;

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

    // Check for "Pair not found" error specifically
    if (data.error && data.error.includes('Pair not found')) {
      return NextResponse.json({
        error: 'Token not found in Axiom database',
        details: 'This token is not tracked by Axiom. Risk data unavailable.',
        pairNotFound: true
      }, { status: 404 })
    }

    // Validate required fields
    if (typeof data.numHolders !== 'number' || typeof data.insidersHoldPercent !== 'number' || typeof data.bundlersHoldPercent !== 'number') {
      rateLimitState.consecutiveErrors++;
      return NextResponse.json({
        error: 'Invalid response format from Axiom API',
        received: data
      }, { status: 500 })
    }

    // Reset error count on success
    rateLimitState.consecutiveErrors = 0;
    rateLimitState.backoffUntil = 0;

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
    
    // Increase error count for exceptions
    rateLimitState.consecutiveErrors++;
    
    // Set backoff if we have consecutive errors
    if (rateLimitState.consecutiveErrors > 1) {
      rateLimitState.backoffUntil = Date.now() + calculateBackoff(rateLimitState.consecutiveErrors, RATE_LIMIT_CONFIG.maxBackoff);
    }

    return NextResponse.json({
      error: 'Failed to fetch token info from Axiom',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
}