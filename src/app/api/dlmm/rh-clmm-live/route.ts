import { NextRequest, NextResponse, connection } from 'next/server'
import { rejectWrongNetwork } from '@/utils/app-network-api'
import {
  isRhOwnerAddress,
  readRhClmmLiveFromDb,
  readRhClmmLiveRedis,
  refreshRhClmmLive,
} from '@/utils/dlmm/rh-clmm-live'

export async function GET(req: NextRequest) {
  await connection()
  const wrong = rejectWrongNetwork(req, 'robinhood')
  if (wrong) return wrong

  try {
    const url = new URL(req.url)
    const owner = (url.searchParams.get('owner') ?? '').trim()
    const fresh =
      url.searchParams.get('fresh') === '1' ||
      url.searchParams.get('fresh') === 'true'

    if (!isRhOwnerAddress(owner)) {
      return NextResponse.json(
        { success: false, error: 'Invalid owner address' },
        { status: 400 },
      )
    }

    if (fresh) {
      const payload = await refreshRhClmmLive(owner)
      return NextResponse.json({
        success: true,
        source: 'live',
        stale: false,
        syncedAt: payload.syncedAt,
        positions: payload.positions,
      })
    }

    const cached = await readRhClmmLiveRedis(owner)
    if (cached?.positions) {
      return NextResponse.json({
        success: true,
        source: 'redis',
        stale: false,
        syncedAt: cached.syncedAt,
        positions: cached.positions,
      })
    }

    const dbRows = await readRhClmmLiveFromDb(owner)
    if (dbRows.length > 0) {
      // Background revalidate — do not block response
      void refreshRhClmmLive(owner).catch((e) => {
        console.warn(
          '[rh-clmm-live] background refresh failed',
          e instanceof Error ? e.message : e,
        )
      })
      return NextResponse.json({
        success: true,
        source: 'db',
        stale: true,
        syncedAt: null,
        positions: dbRows,
      })
    }

    // Cold start: no cache / marks — sync crawl
    const payload = await refreshRhClmmLive(owner)
    return NextResponse.json({
      success: true,
      source: 'live',
      stale: false,
      syncedAt: payload.syncedAt,
      positions: payload.positions,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Live load failed',
        positions: [],
      },
      { status: 500 },
    )
  }
}
