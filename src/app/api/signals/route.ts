import { NextRequest, NextResponse, connection } from 'next/server'
import { query, queryOne } from '@/utils/db'
import { parseDbChain } from '@/utils/app-network-db'
import { getRugList, markTokenRug } from '@/utils/rug-list/service'
import { removeRugEntry } from '@/utils/rug-list/db'
import {
  markTokenPotential,
  unmarkTokenPotential,
} from '@/utils/potential-list/service'

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

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await connection()
    const chain = parseDbChain(request.nextUrl.searchParams.get('chain'))
    const { rows: data } = await query<TradingSignalRow>(
      `SELECT * FROM trading_signals
       WHERE label IN ('watching', 'potential', 'rugged')
         AND chain = $1
       ORDER BY updated_at DESC`,
      [chain],
    )

    const rugEntries = await getRugList(chain)
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
    const body = await request.json()
    const {
      tokenAddress,
      label,
      tokenSymbol,
      price,
      mcap,
      initialPrice,
      result,
      imageReference,
      source,
    } = body
    const chain = parseDbChain(body.chain)

    if (!tokenAddress) {
      return NextResponse.json({ success: false, error: 'Token address required' }, { status: 400 })
    }

    const now = new Date().toISOString()

    const existing = await queryOne<TradingSignalRow>(
      `SELECT * FROM trading_signals WHERE token_address = $1 AND chain = $2 LIMIT 1`,
      [tokenAddress, chain],
    )

    if (existing) {
      const setClauses: string[] = ['updated_at = $3']
      const params: unknown[] = [tokenAddress, chain, now]

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
        `UPDATE trading_signals SET ${setClauses.join(', ')} WHERE token_address = $1 AND chain = $2`,
        params,
      )
    } else {
      await query(
        `INSERT INTO trading_signals (
           token_address, token_symbol, market_cap, price, initial_price,
           updated_at, label, result, image_reference, source, chain
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
          chain,
        ],
      )
    }

    if (label === 'rugged') {
      await markTokenRug({
        tokenAddress,
        tokenSymbol: tokenSymbol || existing?.token_symbol,
        source: 'board',
        chain,
      })
    } else if (label === 'potential') {
      await removeRugEntry(tokenAddress, chain)
      const potSource =
        source === 'mcap_tracker'
          ? 'tracker'
          : source === 'live'
            ? 'live'
            : 'board'
      await markTokenPotential({
        tokenAddress,
        tokenSymbol: tokenSymbol || existing?.token_symbol,
        source: potSource,
        chain,
      })
    } else if (label) {
      await removeRugEntry(tokenAddress, chain)
      try {
        await unmarkTokenPotential(tokenAddress, chain)
      } catch {
        /* ignore */
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
    const chain = parseDbChain(searchParams.get('chain'))

    if (!tokenAddress) {
      return NextResponse.json({ success: false, error: 'Token address required' }, { status: 400 })
    }

    await query(
      `UPDATE trading_signals SET label = NULL WHERE token_address = $1 AND chain = $2`,
      [tokenAddress, chain],
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}
