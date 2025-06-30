import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'

// Database schema for Supabase
interface DatabaseRecord {
  id: string
  wallet_address: string
  operation_type: string
  timestamp: string
  data: any
  created_at?: string
}

// GET /api/trading/records?wallet=<address>&limit=<number>
export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    // const authResult = await validateAuth(request)
    // if (!authResult.valid) {
    //   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // }

    const { searchParams } = new URL(request.url)
    const walletAddress = searchParams.get('wallet')
    const limit = parseInt(searchParams.get('limit') || '500')

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'wallet parameter is required' },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('trading_records')
      .select('*')
      .eq('wallet_address', walletAddress)
      .order('timestamp', { ascending: false })
      .limit(limit)

    if (error) {
      throw error
    }

    return NextResponse.json({
      success: true,
      records: (data || []).map((item: DatabaseRecord) => item.data)
    })
  } catch (error) {
    console.error('Error fetching trading records:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch trading records',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

// POST /api/trading/records - Save new trading record
export async function POST(request: NextRequest) {
  try {
    const record = await request.json()

    if (!record.id || !record.walletAddress || !record.operationType) {
      return NextResponse.json(
        { error: 'Missing required fields: id, walletAddress, operationType' },
        { status: 400 }
      )
    }

    // Skip records with errors
    if (
      (record.errors && record.errors.length > 0) || 
      (record.failureCount > 0 && record.successCount === 0)
    ) {
      return NextResponse.json({ 
        success: true,
        skipped: true,
        reason: 'Record contains errors or represents failed operation'
      })
    }

    const dbRecord: Omit<DatabaseRecord, 'created_at'> = {
      id: record.id,
      wallet_address: record.walletAddress,
      operation_type: record.operationType,
      timestamp: new Date(record.timestamp).toISOString(),
      data: record
    }

    const { error } = await supabase
      .from('trading_records')
      .insert(dbRecord)

    if (error) {
      throw error
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error saving trading record:', error)
    return NextResponse.json(
      { 
        error: 'Failed to save trading record',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

// OPTIONS /api/trading/records - Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
} 