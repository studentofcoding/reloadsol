import { NextRequest, NextResponse, connection } from 'next/server'
import { evaluateConcentrationBan } from '@/strategies/concentration-ban'
import { buildGmgnTokenSnapshot } from '@/strategies/gmgn-token-snapshot'
import { GmgnApiError } from '@/utils/gmgn-api'
import { isGmgnTradeChain, isValidTradeTokenAddress } from '@/utils/gmgn-currencies'
import { isValidMintAddress } from '@/utils/jupiter'
import { getGmgnTokenSnapshotCached } from '@/utils/gmgn-snapshot-cache'

export const maxDuration = 60

function isHoneypot(security: Record<string, unknown>): boolean {
  return (
    security.is_honeypot === 'yes' ||
    security.honeypot === 1 ||
    security.is_honeypot === true
  )
}

/** Map a GMGN client failure to an HTTP status the client can act on. */
function errorStatus(error: unknown): number {
  if (error instanceof GmgnApiError) {
    if (error.code === 'RATE_LIMIT') return 429
    if (error.message.includes('timed out')) return 504
    if (error.message.startsWith('Invalid JSON')) return 502
  }
  return 500
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    if (!process.env.GMGN_API_KEY?.trim()) {
      return NextResponse.json(
        { success: false, error: 'GMGN_API_KEY is not set' },
        { status: 503 },
      )
    }

    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim() ?? ''
    const chainRaw = searchParams.get('chain')?.trim() || 'sol'
    if (!isGmgnTradeChain(chainRaw)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }
    const chain = chainRaw

    const addressOk =
      chain === 'robinhood'
        ? isValidTradeTokenAddress('robinhood', address)
        : isValidMintAddress(address)
    if (!address || !addressOk) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required' },
        { status: 400 },
      )
    }

    const cached = await getGmgnTokenSnapshotCached(chain, address)
    if (!cached) {
      // Soft degrade — UI can hide stats; do not poison Redis or throw 500.
      return NextResponse.json(
        {
          success: false,
          error: 'GMGN token info/security unavailable for this address',
        },
        { status: 502 },
      )
    }

    const { info, security } = cached

    const holdersRaw = info.holder_count ?? info.holders
    const holders =
      typeof holdersRaw === 'number'
        ? holdersRaw
        : typeof holdersRaw === 'string'
          ? Number(holdersRaw)
          : null

    const priceNested =
      info.price && typeof info.price === 'object'
        ? (info.price as Record<string, unknown>).price
        : undefined
    const priceRaw = info.price_usd ?? info.usd_price ?? priceNested ?? info.price
    const priceUsd =
      typeof priceRaw === 'number'
        ? priceRaw
        : typeof priceRaw === 'string'
          ? Number(priceRaw)
          : null

    // Display-only concentration evaluation — no rug-marking side effects on
    // this read path (those live in the strategy/detection pipeline).
    const snapshot = buildGmgnTokenSnapshot(info, security)
    const concBan = evaluateConcentrationBan(snapshot)

    return NextResponse.json({
      success: true,
      address,
      chain,
      ...snapshot,
      holders: Number.isFinite(holders) ? holders : null,
      price_usd: Number.isFinite(priceUsd) ? priceUsd : null,
      isHoneypot: isHoneypot(security),
      concentrationBanned: concBan.ban,
      concentrationReasons: concBan.reasons,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status = errorStatus(error)
    console.error(`[token-snapshot] ${status} ${msg}`, error)
    return NextResponse.json(
      {
        success: false,
        error: msg,
      },
      { status },
    )
  }
}
