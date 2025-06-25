import { NextRequest, NextResponse } from 'next/server'
import { checkProviderHealth } from '@/utils/trade-comparison'

export async function GET(request: NextRequest) {
  try {
    const startTime = Date.now()
    const providerHealth = await checkProviderHealth()
    const responseTime = Date.now() - startTime

    const overallHealth = Object.values(providerHealth).some(status => status)
    const healthyProviders = Object.entries(providerHealth)
      .filter(([_, status]) => status)
      .map(([provider, _]) => provider)

    const response = {
      status: overallHealth ? 'healthy' : 'degraded',
      providers: providerHealth,
      summary: {
        totalProviders: Object.keys(providerHealth).length,
        healthyProviders: healthyProviders.length,
        healthyProvidersList: healthyProviders,
        responseTime
      },
      timestamp: new Date().toISOString(),
      api: {
        version: '1.0.0',
        endpoint: '/api/trade/health'
      }
    }

    return NextResponse.json(response, {
      status: overallHealth ? 200 : 503,
      headers: {
        'Cache-Control': 'public, max-age=60', // Cache for 1 minute
        'X-Response-Time': responseTime.toString()
      }
    })

  } catch (error) {
    console.error('❌ Health check error:', error)
    
    return NextResponse.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}

// Simple HEAD request for uptime monitoring
export async function HEAD(request: NextRequest) {
  try {
    const health = await checkProviderHealth()
    const isHealthy = Object.values(health).some(status => status)
    
    return new NextResponse(null, {
      status: isHealthy ? 200 : 503,
      headers: {
        'X-Provider-Health': JSON.stringify(health),
        'X-Health-Check': 'trade-api'
      }
    })
  } catch (error) {
    return new NextResponse(null, { 
      status: 503,
      headers: {
        'X-Health-Check': 'trade-api',
        'X-Error': 'health-check-failed'
      }
    })
  }
} 