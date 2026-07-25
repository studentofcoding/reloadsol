import { NextRequest, NextResponse } from 'next/server'
import { banConcentrationIfNeeded } from '@/strategies/concentration-ban'
import { buildGmgnTokenSnapshot } from '@/strategies/gmgn-token-snapshot'
import { tokenInfo, tokenSecurity } from '@/utils/gmgn-cli'
import {
  isGmgnTradeChain,
  isValidTradeTokenAddress,
} from '@/utils/gmgn-currencies'
import { isValidMintAddress } from '@/utils/jupiter'

export const dynamic = 'force-dynamic'

function isHoneypot(security: Record<string, unknown>): boolean {
  return (
    security.is_honeypot === 'yes' ||
    security.honeypot === 1 ||
    security.is_honeypot === true
  )
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim() ?? ''
    const chainRaw = searchParams.get('chain')?.trim() || 'sol'
    const chain = isGmgnTradeChain(chainRaw) ? chainRaw : 'sol'

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

    const [info, security] = await Promise.all([
      tokenInfo({ chain, address }),
      tokenSecurity({ chain, address }),
    ])

    const snapshot = buildGmgnTokenSnapshot(info, security)
    const symbol =
      typeof info.symbol === 'string'
        ? info.symbol
        : typeof info.name === 'string'
          ? info.name
          : null

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

    const concBan = await banConcentrationIfNeeded({
      tokenAddress: address,
      tokenSymbol: symbol,
      info,
      security,
    })

    return NextResponse.json(
      {
        success: true,
        address,
        chain,
        ...snapshot,
        holders: Number.isFinite(holders) ? holders : null,
        price_usd: Number.isFinite(priceUsd) ? priceUsd : null,
        isHoneypot: isHoneypot(security as Record<string, unknown>),
        concentrationBanned: concBan.banned,
        concentrationReasons: concBan.reasons,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
