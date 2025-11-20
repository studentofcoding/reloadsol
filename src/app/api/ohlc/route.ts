import { NextRequest, NextResponse } from 'next/server'
import { updateOHLCBars, type OHLCInterval } from '@/utils/ohlc'

const VALID: OHLCInterval[] = ['1m', '5m', '15m', '1h']

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url)
        const intervalParam = (searchParams.get('interval') || '5m') as OHLCInterval
        const store = (searchParams.get('store') || 'true').toLowerCase() !== 'false'

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