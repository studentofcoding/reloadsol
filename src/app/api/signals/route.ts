import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/utils/db'
import { markTokenRug, unmarkTokenRug } from '@/utils/rug-list/service'
import { removeRugEntry } from '@/utils/rug-list/db'
import { getRugList } from '@/utils/rug-list/service'

export const dynamic = 'force-dynamic'

interface TradingSignalRow {
  token_address: string
  token_symbol: string | null
  label: string | null
  market_cap: number
  price: number
  initial_price: number
  result: unknown
  image_reference: string | null
  source: string
  updated_at: string
}

export async function GET(request: NextRequest) {
  try {
    const { rows: data } = await query<TradingSignalRow>(
      `SELECT * FROM trading_signals
       WHERE label IN ('watching', 'potential', 'rugged')
       ORDER BY updated_at DESC`,
    )

    const rugEntries = await getRugList()
    const byAddress = new Map(
      data.map((d) => [d.token_address, d]),
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

    const now = new Date().toISOString()

    const existing = await queryOne<TradingSignalRow>(
      `SELECT * FROM trading_signals WHERE token_address = $1 LIMIT 1`,
      [tokenAddress],
    )

    if (existing) {
      const setClauses: string[] = ['updated_at = $2']
      const params: unknown[] = [tokenAddress, now]

      if (label) {
        setClauses.push(`label = $${params.length + 1}`)
        params.push(label)
      }
      if (tokenSymbol) {
        setClauses.push(`token_symbol = $${params.length + 1}`)
        params.push(tokenSymbol)
      }
      if (mcap) {
        setClauses.push(`market_cap = $${params.length + 1}`)
        params.push(mcap)
      }
      if (price) {
        setClauses.push(`price = $${params.length + 1}`)
        params.push(price)
      }
      if (initialPrice) {
        setClauses.push(`initial_price = $${params.length + 1}`)
        params.push(initialPrice)
      }
      if (result) {
        setClauses.push(`result = $${params.length + 1}`)
        params.push(JSON.stringify(result))
      }
      if (imageReference) {
        setClauses.push(`image_reference = $${params.length + 1}`)
        params.push(imageReference)
      }
      if (source) {
        setClauses.push(`source = $${params.length + 1}`)
        params.push(source)
      }

      await query(
        `UPDATE trading_signals SET ${setClauses.join(', ')} WHERE token_address = $1`,
        params,
      )
    } else {
      await query(
        `INSERT INTO trading_signals (
           token_address, token_symbol, market_cap, price, initial_price,
           updated_at, label, result, image_reference, source
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          tokenAddress,
          tokenSymbol || 'UNKNOWN',
          mcap || 0,
          price || 0,
          initialPrice || price || 0,
          now,
          label || 'watching',
          result ? JSON.stringify(result) : null,
          imageReference || null,
          source || 'manual',
        ],
      )
    }

    if (label === 'rugged') {
      await markTokenRug({
        tokenAddress,
        tokenSymbol: tokenSymbol || existing?.token_symbol,
        source: 'board',
      })
    } else if (label) {
      await removeRugEntry(tokenAddress)
    }

    // potential: await capture so Next doesn't kill the work on response.
    // rug: markTokenRug awaits captureSignalOhlcLabel
    if (label === 'potential') {
      try {
        const { captureSignalOhlcLabel } = await import(
          '@/strategies/signal-ohlc-labels'
        )
        await captureSignalOhlcLabel({
          tokenAddress,
          label: 'potential',
          tokenSymbol: tokenSymbol || existing?.token_symbol,
          source: source === 'mcap_tracker' ? 'signals_mcap' : 'signals_board',
        })
      } catch (err) {
        console.warn('[signals] potential OHLC capture failed', {
          mint: tokenAddress,
          error: err instanceof Error ? err.message : String(err),
        })
      }
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

    await query(
      `UPDATE trading_signals SET label = NULL WHERE token_address = $1`,
      [tokenAddress],
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}
