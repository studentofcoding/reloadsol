import { NextRequest, NextResponse } from 'next/server'
import { getRandomTokens } from '@/utils/jupiter-pools-test'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const count = parseInt(searchParams.get('count') || '10')
    
    // Validate count parameter
    if (count < 1 || count > 50) {
      return NextResponse.json(
        { error: 'Count must be between 1 and 50' },
        { status: 400 }
      )
    }

    console.log(`🎲 Fetching ${count} random tokens...`)
    
    const tokens = await getRandomTokens(count)
    
    if (tokens.length === 0) {
      return NextResponse.json(
        { error: 'No tokens found' },
        { status: 404 }
      )
    }

    console.log(`✅ Successfully fetched ${tokens.length} random tokens`)
    
    return NextResponse.json({
      success: true,
      count: tokens.length,
      tokens
    })
    
  } catch (error) {
    console.error('❌ Random tokens API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch random tokens',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { count = 10 } = body
    
    // Validate count parameter
    if (count < 1 || count > 50) {
      return NextResponse.json(
        { error: 'Count must be between 1 and 50' },
        { status: 400 }
      )
    }

    console.log(`🎲 POST: Fetching ${count} random tokens...`)
    
    const tokens = await getRandomTokens(count)
    
    if (tokens.length === 0) {
      return NextResponse.json(
        { error: 'No tokens found' },
        { status: 404 }
      )
    }

    console.log(`✅ POST: Successfully fetched ${tokens.length} random tokens`)
    
    return NextResponse.json({
      success: true,
      count: tokens.length,
      tokens
    })
    
  } catch (error) {
    console.error('❌ Random tokens POST API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch random tokens',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
} 