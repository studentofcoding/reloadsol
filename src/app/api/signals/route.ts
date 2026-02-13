import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { data, error } = await supabase
      .from('trading_signals')
      .select('*')
      .in('label', ['watching', 'potential', 'rugged'])
      .order('updated_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({
      success: true,
      data: data.map(d => ({
        // Map new schema to old expected format for frontend compatibility if needed, 
        // or frontend can adapt. Let's map to be safe.
        token_address: d.token_address,
        label: d.label,
        mcap: d.market_cap,
        token_symbol: d.token_symbol,
        last_updated_at: d.updated_at,
        price: d.price,
        initial_price: d.initial_price,
        result: d.result,
        image_reference: d.image_reference
      }))
    })
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { tokenAddress, label, tokenSymbol, price, mcap, initialPrice, result, imageReference } = await request.json()

    if (!tokenAddress) {
      return NextResponse.json({ success: false, error: 'Token address required' }, { status: 400 })
    }

    // Upsert logic
    const now = new Date().toISOString()

    // Check if exists
    const { data: existing } = await supabase
      .from('trading_signals')
      .select('*')
      .eq('token_address', tokenAddress)
      .single()

    let error;

    if (existing) {
      // Update existing
      const updateData: any = {
        updated_at: now
      }
      if (label) updateData.label = label
      if (tokenSymbol) updateData.token_symbol = tokenSymbol
      if (mcap) updateData.market_cap = mcap
      if (price) updateData.price = price
      // Only update initial_price if explicitly provided (usually shouldn't change after set)
      if (initialPrice) updateData.initial_price = initialPrice
      if (result) updateData.result = result
      if (imageReference) updateData.image_reference = imageReference

      const { error: upError } = await supabase
        .from('trading_signals')
        .update(updateData)
        .eq('token_address', tokenAddress)
      error = upError
    } else {
      // Insert new
      const { error: inError } = await supabase
        .from('trading_signals')
        .insert({
          token_address: tokenAddress,
          token_symbol: tokenSymbol || 'UNKNOWN',
          market_cap: mcap || 0,
          price: price || 0,
          initial_price: initialPrice || price || 0, // Set initial price to current price if not provided
          updated_at: now,
          label: label || 'watching',
          result: result || null,
          image_reference: imageReference || null
        })
      error = inError
    }

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const tokenAddress = searchParams.get('tokenAddress')

    if (!tokenAddress) {
      return NextResponse.json({ success: false, error: 'Token address required' }, { status: 400 })
    }

    // Just clear the label to remove from view
    const { error } = await supabase
      .from('trading_signals')
      .update({ label: null })
      .eq('token_address', tokenAddress)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}
