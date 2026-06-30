// Daily summary for the `daily_summary` Go cron worker (`POST /api/trending/summary`)
import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { query } from '@/utils/db'

const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'
const SUMMARY_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_summary_dev' : 'trending_token_summary'

interface TrackedToken {
  id: string
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  last_price_usd: number
  peak_price_usd: number
  current_gain_percentage: number
  peak_gain_percentage: number
  status: 'tracking' | 'won' | 'lost'
  organic_score: number | null
  market_cap: number | null
  volume_1h: number | null
  tracking_started_at: string
  status_changed_at: string | null
  created_at: string
  updated_at: string
}

interface TopWinner {
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  peak_price_usd: number
  peak_gain_percentage: number
  tracking_duration_hours: number
  status_changed_at: string
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET
    if (!expectedSecretKey) {
      return NextResponse.json(
        { error: 'Server configuration error: missing TRENDING_TRACKER_SECRET' },
        { status: 500 },
      )
    }

    const isVercelCron =
      request.headers.get('vercel-cron') === '1' ||
      request.headers.get('user-agent')?.includes('vercel-cron') ||
      (process.env.VERCEL === '1' && !secretKey && !request.headers.get('referer'))

    const isDevelopment = process.env.NODE_ENV === 'development'
    const isLocalhost =
      request.headers.get('host')?.includes('localhost') ||
      request.headers.get('host')?.includes('127.0.0.1')

    if (isVercelCron) {
      console.log('🤖 Vercel cron job detected: allowing summary API call')
    } else if (isDevelopment && isLocalhost && !secretKey) {
      console.log('🔓 Development mode: allowing summary API call without secret key')
    } else if (secretKey !== expectedSecretKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    console.log('📊 Starting 24-hour trending token summary...')

    const currentTime = new Date()
    const periodStart = new Date(currentTime.getTime() - 24 * 60 * 60 * 1000)

    const { rows: allTokens } = await query<TrackedToken>(
      `SELECT * FROM ${TRACKER_TABLE} WHERE tracking_started_at >= $1`,
      [periodStart.toISOString()],
    )

    if (!allTokens || allTokens.length === 0) {
      console.log('📭 No tokens tracked in the last 24 hours')
      return NextResponse.json({
        success: true,
        message: 'No tokens tracked in the last 24 hours',
        summary: {
          total_tokens_tracked: 0,
          won_tokens: 0,
          lost_tokens: 0,
          still_tracking: 0,
          win_rate: 0,
          top_winners: [],
        },
      })
    }

    const tokens = allTokens
    console.log(`🔍 Found ${tokens.length} tokens tracked in the last 24 hours`)

    const trackingTokens = tokens.filter((t) => t.status === 'tracking')
    const lostTokens = tokens.filter((t) => t.status === 'lost')
    const wonTokens = tokens.filter((t) => t.status === 'won')

    const topPerformers = trackingTokens
      .filter((token) => token.peak_gain_percentage > 0)
      .sort((a, b) => b.peak_gain_percentage - a.peak_gain_percentage)
      .slice(0, 5)

    console.log(`🏆 Found ${topPerformers.length} top performers to mark as winners`)

    const updatePromises = topPerformers.map((token) =>
      query(
        `UPDATE ${TRACKER_TABLE} SET status = 'won', status_changed_at = $1 WHERE id = $2`,
        [currentTime.toISOString(), token.id],
      ),
    )

    const results = await Promise.allSettled(updatePromises)
    const failedUpdates = results.filter((result) => result.status === 'rejected')

    if (failedUpdates.length > 0) {
      console.error(`⚠️ ${failedUpdates.length} winner updates failed:`, failedUpdates)
    }

    const totalCompleted = lostTokens.length + topPerformers.length + wonTokens.length
    const totalWon = topPerformers.length + wonTokens.length
    const winRate = totalCompleted > 0 ? (totalWon / totalCompleted) * 100 : 0

    const allGains = [...topPerformers, ...wonTokens].map((t) => t.peak_gain_percentage)
    const allLosses = lostTokens.map((t) => Math.abs(t.current_gain_percentage))

    const avgPeakGain =
      allGains.length > 0 ? allGains.reduce((a, b) => a + b, 0) / allGains.length : 0
    const maxPeakGain = allGains.length > 0 ? Math.max(...allGains) : 0
    const avgLoss =
      allLosses.length > 0 ? allLosses.reduce((a, b) => a + b, 0) / allLosses.length : 0

    const topWinnersData: TopWinner[] = topPerformers.map((token) => {
      const trackingStart = new Date(token.tracking_started_at)
      const trackingDuration =
        (currentTime.getTime() - trackingStart.getTime()) / (1000 * 60 * 60)

      return {
        token_address: token.token_address,
        token_symbol: token.token_symbol,
        token_name: token.token_name,
        logo_url: token.logo_url,
        initial_price_usd: token.initial_price_usd,
        peak_price_usd: token.peak_price_usd,
        peak_gain_percentage: token.peak_gain_percentage,
        tracking_duration_hours: Math.round(trackingDuration * 100) / 100,
        status_changed_at: currentTime.toISOString(),
      }
    })

    const summaryId = `summary_${Date.now()}`
    await query(
      `INSERT INTO ${SUMMARY_TABLE} (
         id, period_start, period_end, total_tokens_tracked, won_tokens, lost_tokens,
         still_tracking, win_rate, top_winners, avg_peak_gain, max_peak_gain, avg_loss
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        summaryId,
        periodStart.toISOString(),
        currentTime.toISOString(),
        tokens.length,
        totalWon,
        lostTokens.length,
        trackingTokens.length - topPerformers.length,
        Math.round(winRate * 100) / 100,
        JSON.stringify(topWinnersData),
        Math.round(avgPeakGain * 100) / 100,
        Math.round(maxPeakGain * 100) / 100,
        Math.round(avgLoss * 100) / 100,
      ],
    )

    const completedTokenIds = [...topPerformers.map((t) => t.id), ...lostTokens.map((t) => t.id)]
    if (completedTokenIds.length > 0) {
      console.log(`🧹 Cleaning up ${completedTokenIds.length} completed tracking records`)
    }

    const summary = {
      success: true,
      timestamp: currentTime.toISOString(),
      period: {
        start: periodStart.toISOString(),
        end: currentTime.toISOString(),
        duration_hours: 24,
      },
      statistics: {
        total_tokens_tracked: tokens.length,
        won_tokens: totalWon,
        lost_tokens: lostTokens.length,
        still_tracking: trackingTokens.length - topPerformers.length,
        win_rate: Math.round(winRate * 100) / 100,
        avg_peak_gain: Math.round(avgPeakGain * 100) / 100,
        max_peak_gain: Math.round(maxPeakGain * 100) / 100,
        avg_loss: Math.round(avgLoss * 100) / 100,
      },
      top_winners: topWinnersData,
      top_performers_marked: topPerformers.length,
      failed_updates: failedUpdates.length,
      message: `Summary complete: ${totalWon} wins, ${lostTokens.length} losses, ${winRate.toFixed(1)}% win rate`,
    }

    console.log('✅ 24-hour summary completed:', summary.message)

    return NextResponse.json(summary)
  } catch (error) {
    console.error('❌ Error in trending token summary:', error)
    return NextResponse.json(
      {
        error: 'Failed to generate trending token summary',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
