import { NextRequest, NextResponse } from 'next/server'
import { tokenInfo, walletHoldings, GmgnApiError } from '@/utils/gmgn-api'
import type { UserToken } from '@/utils/jupiter'
import {
  extractGmgnTokenUsdPrice,
  fetchBlockscoutErc20Tokens,
  isEvmAddress,
  normalizeGmgnHolding,
  sortRhTokensByUsd,
} from '@/utils/rh-wallet-holdings'

export const dynamic = 'force-dynamic'

const PRICE_FILL_CAP = 15

async function fillMissingUsd(tokens: UserToken[]): Promise<UserToken[]> {
  let fills = 0
  const out: UserToken[] = []
  for (const t of tokens) {
    if (t.usdValue > 0 || fills >= PRICE_FILL_CAP) {
      out.push(t)
      continue
    }
    try {
      const info = await tokenInfo({
        chain: 'robinhood',
        address: t.mintAddress,
      })
      const px = extractGmgnTokenUsdPrice(info)
      fills += 1
      out.push(px > 0 ? { ...t, usdValue: t.uiAmount * px } : t)
    } catch {
      out.push(t)
    }
  }
  return out
}

export async function GET(request: NextRequest) {
  try {
    const wallet = request.nextUrl.searchParams.get('wallet')?.trim() ?? ''
    if (!isEvmAddress(wallet)) {
      return NextResponse.json(
        { success: false, error: 'wallet must be a 0x EVM address' },
        { status: 400 },
      )
    }
    const walletNorm = wallet.toLowerCase()

    let source: 'gmgn' | 'blockscout' = 'gmgn'
    let tokens: UserToken[] = []

    try {
      if (process.env.GMGN_API_KEY?.trim() && process.env.GMGN_PRIVATE_KEY?.trim()) {
        const rows = await walletHoldings({
          chain: 'robinhood',
          wallet: walletNorm,
          limit: 100,
        })
        tokens = rows
          .map((r) => normalizeGmgnHolding(r))
          .filter((t): t is UserToken => t != null)
      }
    } catch (err) {
      if (err instanceof GmgnApiError && err.code === 'RATE_LIMIT') {
        return NextResponse.json(
          { success: false, error: err.message },
          { status: 429 },
        )
      }
      tokens = []
    }

    if (tokens.length === 0) {
      source = 'blockscout'
      tokens = await fetchBlockscoutErc20Tokens(walletNorm)
      tokens = await fillMissingUsd(tokens)
    }

    tokens = sortRhTokensByUsd(tokens)
    return NextResponse.json({
      success: true,
      tokens,
      source,
      wallet: walletNorm,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
