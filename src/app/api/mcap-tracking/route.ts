import { NextRequest, NextResponse } from 'next/server'
import { trackTokenMcap, getMcapDisplayString, isInTrackingRange, cleanupOldMcapRecords } from '@/utils/mcap-tracker'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')
    const tokenAddress = searchParams.get('token')
    const tokenSymbol = searchParams.get('symbol')
    const mcap = searchParams.get('mcap')

    if (action === 'track' && tokenAddress && tokenSymbol && mcap) {
      const mcapValue = parseInt(mcap)
      const result = await trackTokenMcap(tokenAddress, tokenSymbol, mcapValue)
      const displayString = getMcapDisplayString(result)
      
      return NextResponse.json({
        success: true,
        tracking: result,
        display: displayString,
        inRange: isInTrackingRange(mcapValue)
      })
    }

    if (action === 'cleanup') {
      const days = parseInt(searchParams.get('days') || '30')
      await cleanupOldMcapRecords(days)
      
      return NextResponse.json({
        success: true,
        message: `Cleaned up MCap records older than ${days} days`
      })
    }

    return NextResponse.json({
      success: false,
      error: 'Invalid action or missing parameters'
    }, { status: 400 })

  } catch (error) {
    console.error('Error in MCap tracking API:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { tokens } = await request.json()
    
    if (!Array.isArray(tokens)) {
      return NextResponse.json({
        success: false,
        error: 'Tokens must be an array'
      }, { status: 400 })
    }

    const results = new Map()
    
    for (const token of tokens) {
      if (!token.address || !token.symbol || typeof token.mcap !== 'number') {
        continue
      }
      
      const result = await trackTokenMcap(token.address, token.symbol, token.mcap)
      results.set(token.address, {
        ...result,
        display: getMcapDisplayString(result),
        inRange: isInTrackingRange(token.mcap)
      })
    }

    return NextResponse.json({
      success: true,
      results: Object.fromEntries(results),
      totalTracked: results.size
    })

  } catch (error) {
    console.error('Error in bulk MCap tracking:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}