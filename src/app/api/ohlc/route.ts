import { NextRequest, NextResponse } from 'next/server'
import { updateOHLCBars, type OHLCInterval } from '@/utils/ohlc'
import { supabase } from '@/utils/supabase'

const VALID: OHLCInterval[] = ['1m', '5m', '15m', '1h']

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const intervalParam = (searchParams.get('interval') || '5m') as OHLCInterval
        const mint = searchParams.get('mint')
        const limit = parseInt(searchParams.get('limit') || '288', 10)
        const from = searchParams.get('from')

        if (!VALID.includes(intervalParam)) {
            return NextResponse.json({ success: false, error: 'Invalid interval' }, { status: 400 })
        }

        if (!mint) {
            return NextResponse.json({ success: false, error: 'mint is required' }, { status: 400 })
        }

        let query = supabase
            .from('token_ohlc_bars')
            .select('token_address, interval, open, high, low, close, timestamp')
            .eq('token_address', mint)
            .eq('interval', intervalParam)
            .order('timestamp', { ascending: true })
            .limit(limit)

        if (from) {
            query = query.gte('timestamp', from)
        }

        const { data, error } = await query
        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            interval: intervalParam,
            count: data?.length || 0,
            bars: data || []
        })
    } catch (error) {
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Internal error' },
            { status: 500 }
        )
    }
}

export async function POST(request: NextRequest) {
    try {
        const token = process.env.OHLC_UPDATE_TOKEN
        if (token && request.headers.get('authorization') !== `Bearer ${token}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const contentType = request.headers.get('content-type') || ''
        let intervalParam: OHLCInterval = '5m'
        let store = true

        if (contentType.includes('application/json')) {
            const body = await request.json().catch(() => ({}))
            intervalParam = (body.interval || '5m') as OHLCInterval
            store = (body.store ?? true) !== false
        } else {
            const { searchParams } = new URL(request.url)
            intervalParam = (searchParams.get('interval') || '5m') as OHLCInterval
            store = (searchParams.get('store') || 'true').toLowerCase() !== 'false'
        }

        if (!VALID.includes(intervalParam)) {
            return NextResponse.json({ success: false, error: 'Invalid interval' }, { status: 400 })
        }

        const result = await updateOHLCBars({ interval: intervalParam, store })

        return NextResponse.json({
            success: true,
            interval: intervalParam,
            stored: result.stored,
            count: result.bars.length,
            timestamp: result.bars[0]?.timestamp || null
        })
    } catch (error) {
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Internal error' },
            { status: 500 }
        )
    }
}