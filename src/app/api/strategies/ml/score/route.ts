import { NextRequest, NextResponse, connection } from 'next/server'
import { loadCombinedScore } from '@/strategies/combined-score-load'
import { isMlClosedLoopEnabled } from '@/strategies/closed-loop-ml'
import {
  isGmgnTradeChain,
  isValidAnyChainTokenAddress,
} from '@/utils/gmgn-currencies'

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim() ?? ''
    const hoursRaw = Number(searchParams.get('hours') ?? 24)
    const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 168) : 24
    const chainRaw =
      searchParams.get('chain')?.trim() || (/^0x/i.test(address) ? 'robinhood' : 'sol')

    if (!isGmgnTradeChain(chainRaw)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood', mlScore: null, modelVersion: null },
        { status: 400 },
      )
    }
    if (!address || !isValidAnyChainTokenAddress(address)) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required', mlScore: null, modelVersion: null },
        { status: 400 },
      )
    }

    if (!isMlClosedLoopEnabled()) {
      return NextResponse.json(
        { success: true, mlScore: null, modelVersion: null, enabled: false },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    try {
      const payload = await loadCombinedScore({
        address,
        chain: chainRaw,
        hours,
      })
      return NextResponse.json(
        {
          success: true,
          mlScore: payload.mlScore ?? null,
          modelVersion: payload.modelVersion ?? null,
          enabled: true,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    } catch {
      return NextResponse.json(
        { success: true, mlScore: null, modelVersion: null, enabled: true },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
  } catch (error) {
    return NextResponse.json(
      {
        success: true,
        mlScore: null,
        modelVersion: null,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
