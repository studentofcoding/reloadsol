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
        // Fix: Ensure we use the latest available price data
        const currentPrice = priceData[t.token_address]?.price
        const lastKnownPrice = t.last_price_usd ?? 0
        
        // If we have a fresh price from Jupiter, use it as close. 
        // If not, fall back to last_price_usd from DB.
        const close = currentPrice ?? lastKnownPrice
        
        // If we have no price data at all, skip this token
        if (close <= 0) return null

        // Open price logic:
        // Ideally, 'open' for a new bar should be the 'close' of the previous bar.
        // However, in this stateless update function, we might not have the previous bar handy.
        // A reasonable approximation for 5m bars is:
        // - If we have a last_price_usd stored in the tracker table, treat that as the "previous" state (Open).
        // - If last_price_usd is missing or same as current, Open = Close (doji bar).
        // - REAL FIX: In a real system, you'd query the *previous* OHLC bar to get its close.
        // For now, let's stick to the existing logic but make it robust.
        const open = t.last_price_usd ?? close

        // High/Low logic:
        // Since we only have two data points (Open/Close) for this interval snapshot,
        // High is max(Open, Close) and Low is min(Open, Close).
        // This creates "flat" bars if price hasn't moved, or simple candles if it has.
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
    }).filter((b): b is OHLCBar => b !== null && b.close > 0 && b.open > 0)

    let stored = 0
    if (store && bars.length > 0) {
        const { data: existing, error: selectErr } = await supabase
            .from('token_ohlc_bars')
            .select('token_address')
            .in('token_address', addresses)
            .eq('interval', interval)
            .eq('timestamp', tsIso)

        if (!selectErr) {
            const existingSet = new Set((existing || []).map(r => r.token_address))
            const toInsert = bars.filter(b => !existingSet.has(b.token_address))
            if (toInsert.length > 0) {
                const { error: insertErr } = await supabase.from('token_ohlc_bars').insert(toInsert)
                if (!insertErr) stored = toInsert.length
            }
            console.debug('ohlc_insert', { interval, timestamp: tsIso, total: bars.length, inserted: stored, skipped: bars.length - stored })
        } else {
            const { error: insertErr } = await supabase.from('token_ohlc_bars').insert(bars)
            if (!insertErr) stored = bars.length
        }
    }

    return { bars, stored }
}