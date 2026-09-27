import { NextRequest, NextResponse, connection } from 'next/server'
import { query, queryOne } from '@/utils/db'
import { captureManualMcapRisingOhlc, TokenLabel } from '@/utils/mcap-tracker'
import { log } from '@/utils/unified-logger'
import { markTokenRug } from '@/utils/rug-list/service'
import { removeRugEntry } from '@/utils/rug-list/db'
import {
  TRACKER_WRITE_LABELS,
  canonicalTrackerLabel,
  coerceTrackerLabelWrite,
} from '@/utils/tracker-label'

const VALID_LABELS: TokenLabel[] = [...TRACKER_WRITE_LABELS]

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { tokenAddress } = body
    const coerced = coerceTrackerLabelWrite(
      body.label === undefined ? null : body.label,
    )
    if (!coerced.ok) {
      return NextResponse.json({
        success: false,
        error: `Invalid label. Must be one of: ${VALID_LABELS.join(', ')}, or null to clear`
      }, { status: 400 })
    }
    const label = coerced.label

    // Validate input
    if (!tokenAddress || typeof tokenAddress !== 'string') {
      return NextResponse.json({
        success: false,
        error: 'Token address is required and must be a string'
      }, { status: 400 })
    }

    log.info('api_request', 'Updating token label', {
      tokenAddress,
      label: label || 'cleared'
    })

    const existingToken = await queryOne<{
      token_address: string
      token_symbol: string
      label: TokenLabel | null
    }>(
      `SELECT token_address, token_symbol, label
       FROM token_mcap_tracking
       WHERE token_address = $1`,
      [tokenAddress],
    )

    if (!existingToken) {
      return NextResponse.json({
        success: false,
        error: 'Token not found in tracking database'
      }, { status: 404 })
    }

    await query(
      `UPDATE token_mcap_tracking SET label = $2 WHERE token_address = $1`,
      [tokenAddress, label || null],
    )

    if (label === 'rugged') {
      await markTokenRug({
        tokenAddress,
        tokenSymbol: existingToken.token_symbol,
        source: 'signals-label',
      })
    } else if (existingToken.label === 'rugged') {
      await removeRugEntry(tokenAddress)
    }

    if (label === 'rising') {
      await captureManualMcapRisingOhlc(tokenAddress, existingToken.token_symbol)
    }

    log.info('api_request', 'Successfully updated token label', {
      tokenAddress,
      tokenSymbol: existingToken.token_symbol,
      previousLabel: existingToken.label || 'none',
      newLabel: label || 'cleared'
    })

    return NextResponse.json({
      success: true,
      message: 'Token label updated successfully',
      data: {
        tokenAddress,
        tokenSymbol: existingToken.token_symbol,
        previousLabel: existingToken.label,
        newLabel: label
      }
    })

  } catch (error) {
    log.error('error_handling', 'Error updating token label', error as Error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const tokenAddress = searchParams.get('token')
    const labelFilter = searchParams.get('label')

    // Get specific token label
    if (tokenAddress) {
      const data = await queryOne<{
        token_address: string
        token_symbol: string
        label: TokenLabel | null
      }>(
        `SELECT token_address, token_symbol, label
         FROM token_mcap_tracking
         WHERE token_address = $1`,
        [tokenAddress],
      )

      if (!data) {
        return NextResponse.json({
          success: false,
          error: 'Token not found'
        }, { status: 404 })
      }

      return NextResponse.json({
        success: true,
        data: {
          ...data,
          label: canonicalTrackerLabel(data.label) ?? null,
        },
      })
    }

    // Get tokens by label filter
    if (labelFilter) {
      const filter = coerceTrackerLabelWrite(labelFilter)
      if (!filter.ok || filter.label == null) {
        return NextResponse.json({
          success: false,
          error: `Invalid label filter. Must be one of: ${VALID_LABELS.join(', ')}`
        }, { status: 400 })
      }

      const { rows: data } = await query(
        `SELECT token_address, token_symbol, label, mcap_growth_percent, last_updated_at
         FROM token_mcap_tracking
         WHERE label = $1 OR ($1 = 'rising' AND label = 'potential')
         ORDER BY last_updated_at DESC`,
        [filter.label],
      )

      const presented = data.map((row) => ({
        ...row,
        label: canonicalTrackerLabel(
          (row as { label?: string | null }).label,
        ) ?? null,
      }))

      return NextResponse.json({
        success: true,
        data: presented,
        count: presented.length
      })
    }

    // Get label statistics
    const { rows: data } = await query<{ label: TokenLabel | null }>(
      `SELECT label FROM token_mcap_tracking`,
    )

    const labelStats = data.reduce((acc, token) => {
      const tokenLabel = canonicalTrackerLabel(token.label) || 'unlabeled'
      acc[tokenLabel] = (acc[tokenLabel] || 0) + 1
      return acc
    }, {} as Record<string, number>)

    return NextResponse.json({
      success: true,
      data: {
        validLabels: VALID_LABELS,
        statistics: labelStats,
        totalTokens: data.length
      }
    })

  } catch (error) {
    log.error('error_handling', 'Error fetching token labels', error as Error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    }, { status: 500 })
  }
}
