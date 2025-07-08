import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'
import { calculateGainPercentage } from '@/utils/trading-math'
import { sendTradeAlertDiscord, TradeAlertStatus } from '@/utils/discord'

// Use same tables as other routes
const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

export const runtime = 'edge'

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expected = process.env.TRENDING_TRACKER_SECRET || 'trending-track-secret'
    if (secretKey !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const thresholdParam = searchParams.get('threshold')
    const threshold = thresholdParam ? parseFloat(thresholdParam) : 0.5

    // Fetch tokens with real trading positions still holding
    const { data: tokens, error } = await supabase
      .from(TRACKER_TABLE)
      .select('*')
      .eq('status', 'tracking')
      .not('trading_simulation', 'is', null)

    if (error) throw error

    const toProcess = (tokens || []).filter(t => {
      const sim = t.trading_simulation as any
      return sim && !sim.is_simulated && sim.current_status === 'holding'
    })

    let alertsSent = 0
    let updated = 0

    for (const token of toProcess) {
      try {
        // Fetch current price via internal price API to minimise heavy calls
        const priceResp = await fetch(`${process.env.VERCEL_URL || 'https://v2.reloadsol.xyz'}/api/tokens/prices?token=${token.token_address}`)
        if (!priceResp.ok) continue
        const { priceUsd } = await priceResp.json()
        if (!priceUsd || priceUsd <= 0) continue

        const diffPercent = calculateGainPercentage(priceUsd, token.last_price_usd)
        if (Math.abs(diffPercent) < threshold) continue

        const peakGain = token.peak_gain_percentage
        const currentGain = calculateGainPercentage(priceUsd, token.initial_price_usd)

        // Update Supabase
        const { error: upErr } = await supabase
          .from(TRACKER_TABLE)
          .update({ last_price_usd: priceUsd, current_gain_percentage: currentGain })
          .eq('id', token.id)
        if (upErr) throw upErr
        updated++

        // Discord alert
        try {
          await sendTradeAlertDiscord({
            tokenSymbol: token.token_symbol,
            status: 'buy' as TradeAlertStatus, // reuse status for price change alert
            isSimulated: false,
            currentGain: currentGain,
            peakGain: peakGain,
            priceUsd: priceUsd
          })
          alertsSent++
        } catch {}
      } catch (inner) {
        console.error('Price monitor error for token', token.token_symbol, inner)
      }
    }

    return NextResponse.json({ success: true, processed: toProcess.length, updated, alertsSent })
  } catch (err: any) {
    console.error('Price monitor route failed', err)
    return NextResponse.json({ error: err.message || 'internal' }, { status: 500 })
  }
} 