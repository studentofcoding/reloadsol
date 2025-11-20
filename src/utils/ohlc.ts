export type OHLCInterval = '1m' | '5m' | '15m' | '1h'

export interface OHLCBar {
    token_address: string
    interval: OHLCInterval
    open: number
    high: number
    low: number
    close: number
    timestamp: string
}

import { supabase } from '@/utils/supabase'
import { fetchTokenPricesBatch } from '@/utils/jupiter-api'

function alignTimestamp(interval: OHLCInterval, date = new Date()): Date {
    const d = new Date(date)
    d.setSeconds(0, 0)
    const m = d.getMinutes()
    if (interval === '1m') return d
    if (interval === '5m') d.setMinutes(m - (m % 5))
    else if (interval === '15m') d.setMinutes(m - (m % 15))
    else if (interval === '1h') d.setMinutes(0)
    return d
}

export async function updateOHLCBars(options: { interval: OHLCInterval; store?: boolean }) {
    const { interval, store = true } = options
    const TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

    const { data: tokens, error } = await supabase
        .from(TABLE)
        .select('id, token_address, last_price_usd, updated_at, status')
        .eq('status', 'tracking')

    if (error) throw error
    const addresses = (tokens || []).map(t => t.token_address)
    if (addresses.length === 0) return { bars: [] as OHLCBar[], stored: 0 }

    const priceData = await fetchTokenPricesBatch(addresses, { batchSize: 100, timeout: 10000, retries: 1 })
    const ts = alignTimestamp(interval)
    const tsIso = ts.toISOString()

    const bars: OHLCBar[] = (tokens || []).map(t => {
        const close = priceData[t.token_address]?.price ?? t.last_price_usd ?? 0
        const open = t.last_price_usd ?? close
        const high = Math.max(open, close)
        const low = Math.min(open, close)
        return {
            token_address: t.token_address,
            interval,
            open,
            high,
            low,
            close,
            timestamp: tsIso
        }
    }).filter(b => b.close > 0 && b.open > 0)

    let stored = 0
    if (store && bars.length > 0) {
        const { error: insertErr } = await supabase.from('token_ohlc_bars').insert(bars)
        if (!insertErr) stored = bars.length
    }

    return { bars, stored }
}