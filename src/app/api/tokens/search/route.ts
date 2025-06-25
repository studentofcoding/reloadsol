import { NextRequest, NextResponse } from 'next/server'
import { searchTokenStats } from '@/utils/jupiter-pools-test'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')
    
    if (!address) {
      return NextResponse.json(
        { error: 'Token address is required' },
        { status: 400 }
      )
    }

    // Validate address format (basic Solana address validation)
    if (address.length < 32 || address.length > 44) {
      return NextResponse.json(
        { error: 'Invalid token address format' },
        { status: 400 }
      )
    }

    console.log(`🔍 Searching token stats for: ${address}`)
    
    const tokenStats = await searchTokenStats(address)
    
    if (!tokenStats) {
      return NextResponse.json(
        { error: 'Token not found or data unavailable' },
        { status: 404 }
      )
    }

    console.log(`✅ Successfully found stats for token: ${tokenStats.basic.symbol}`)
    
    return NextResponse.json({
      success: true,
      token: tokenStats
    })
    
  } catch (error) {
    console.error('❌ Token search API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to search token stats',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { address } = body
    
    if (!address) {
      return NextResponse.json(
        { error: 'Token address is required' },
        { status: 400 }
      )
    }

    // Validate address format
    if (address.length < 32 || address.length > 44) {
      return NextResponse.json(
        { error: 'Invalid token address format' },
        { status: 400 }
      )
    }

    console.log(`🔍 POST: Searching token stats for: ${address}`)
    
    const tokenStats = await searchTokenStats(address)
    
    if (!tokenStats) {
      return NextResponse.json(
        { error: 'Token not found or data unavailable' },
        { status: 404 }
      )
    }

    console.log(`✅ POST: Successfully found stats for token: ${tokenStats.basic.symbol}`)
    
    return NextResponse.json({
      success: true,
      token: tokenStats
    })
    
  } catch (error) {
    console.error('❌ Token search POST API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to search token stats',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
} 