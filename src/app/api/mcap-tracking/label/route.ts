import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabase } from '@/utils/supabase'
import { TokenLabel } from '@/utils/mcap-tracker'
import { log } from '@/utils/unified-logger'

// Valid label values
const VALID_LABELS: TokenLabel[] = ['valid', 'traded_live', 'potential', 'rugged', 'watching']

export async function PUT(request: NextRequest) {
  try {
    const { tokenAddress, label } = await request.json()

    // Validate input
    if (!tokenAddress || typeof tokenAddress !== 'string') {
      return NextResponse.json({
        success: false,
        error: 'Token address is required and must be a string'
      }, { status: 400 })
    }

    // Validate label (null is allowed to clear the label)
    if (label !== null && label !== undefined && !VALID_LABELS.includes(label)) {
      return NextResponse.json({
        success: false,
        error: `Invalid label. Must be one of: ${VALID_LABELS.join(', ')}, or null to clear`
      }, { status: 400 })
    }

    log.info('api_request', 'Updating token label', {
      tokenAddress,
      label: label || 'cleared'
    })

    // Check if token exists in tracking
    const { data: existingToken, error: fetchError } = await supabase
      .from('token_mcap_tracking')
      .select('token_address, token_symbol, label')
      .eq('token_address', tokenAddress)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return NextResponse.json({
          success: false,
          error: 'Token not found in tracking database'
        }, { status: 404 })
      }
      throw fetchError
    }

    // Update the label
    const { error: updateError } = await supabase
      .from('token_mcap_tracking')
      .update({ label: label || null })
      .eq('token_address', tokenAddress)

    if (updateError) {
      log.error('api_request', 'Failed to update token label', updateError as Error, {
        tokenAddress,
        label
      })
      throw updateError
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
  try {
    const { searchParams } = new URL(request.url)
    const tokenAddress = searchParams.get('token')
    const labelFilter = searchParams.get('label')

    // Get specific token label
    if (tokenAddress) {
      const { data, error } = await supabase
        .from('token_mcap_tracking')
        .select('token_address, token_symbol, label')
        .eq('token_address', tokenAddress)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          return NextResponse.json({
            success: false,
            error: 'Token not found'
          }, { status: 404 })
        }
        throw error
      }

      return NextResponse.json({
        success: true,
        data
      })
    }

    // Get tokens by label filter
    if (labelFilter) {
      if (!VALID_LABELS.includes(labelFilter as TokenLabel)) {
        return NextResponse.json({
          success: false,
          error: `Invalid label filter. Must be one of: ${VALID_LABELS.join(', ')}`
        }, { status: 400 })
      }

      const { data, error } = await supabase
        .from('token_mcap_tracking')
        .select('token_address, token_symbol, label, mcap_growth_percent, last_updated_at')
        .eq('label', labelFilter)
        .order('last_updated_at', { ascending: false })

      if (error) throw error

      return NextResponse.json({
        success: true,
        data,
        count: data.length
      })
    }

    // Get label statistics
    const { data, error } = await supabase
      .from('token_mcap_tracking')
      .select('label')

    if (error) throw error

    const labelStats = data.reduce((acc, token) => {
      const label = token.label || 'unlabeled'
      acc[label] = (acc[label] || 0) + 1
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