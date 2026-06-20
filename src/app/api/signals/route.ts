import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'
import { markTokenRug, unmarkTokenRug } from '@/utils/rug-list/service'
import { removeRugEntry } from '@/utils/rug-list/db'
import { getRugList } from '@/utils/rug-list/service'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { data, error } = await supabase
      .from('trading_signals')
      .select('*')
      .in('label', ['watching', 'potential', 'rugged'])
      .order('updated_at', { ascending: false })

    if (error) throw error

    const rugEntries = await getRugList()
    const byAddress = new Map(
      (data ?? []).map((d) => [d.token_address, d]),
    )

    for (const rug of rugEntries) {
      if (byAddress.has(rug.token_address)) {
        const row = byAddress.get(rug.token_address)!
        if (row.label !== 'rugged') {
          row.label = 'rugged'
        }
      } else {
        byAddress.set(rug.token_address, {
          token_address: rug.token_address,
          token_symbol: rug.token_symbol,
          label: 'rugged',
          market_cap: 0,
          price: 0,
          initial_price: 0,
          result: null,
          image_reference: null,
          source: rug.source,
          updated_at: rug.added_at,
        })
      }
    }

    const merged = Array.from(byAddress.values()).sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )

    return NextResponse.json({
      success: true,
      data: merged.map(d => ({
        token_address: d.token_address,
        label: d.label,
        mcap: d.market_cap,
        token_symbol: d.token_symbol,
        last_updated_at: d.updated_at,
        price: d.price,
        initial_price: d.initial_price,
        result: d.result,
        image_reference: d.image_reference,
        source: d.source
      }))
    })
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { tokenAddress, label, tokenSymbol, price, mcap, initialPrice, result, imageReference, source } = await request.json()

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
      // Source is usually immutable, but allow update if provided explicitly
      if (source) updateData.source = source

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
          image_reference: imageReference || null,
          source: source || 'manual'
        })
      error = inError
    }

    if (error) throw error

    if (label === 'rugged') {
      await markTokenRug({
        tokenAddress,
        tokenSymbol: tokenSymbol || existing?.token_symbol,
        source: 'board',
      })
    } else if (label) {
      await removeRugEntry(tokenAddress)
    }

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
