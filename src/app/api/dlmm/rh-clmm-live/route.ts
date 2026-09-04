import { NextRequest, NextResponse, connection } from 'next/server'
import { rejectWrongNetwork } from '@/utils/app-network-api'
import {
  isRhOwnerAddress,
  loadRhClmmLiveForOwner,
} from '@/utils/dlmm/rh-clmm-live'

export async function GET(req: NextRequest) {
  await connection()
  const wrong = rejectWrongNetwork(req, 'robinhood')
  if (wrong) return wrong

  try {
    const url = new URL(req.url)
    const owner = (url.searchParams.get('owner') ?? '').trim()

    if (!isRhOwnerAddress(owner)) {
      return NextResponse.json(
        { success: false, error: 'Invalid owner address' },
        { status: 400 },
      )
    }

    // `fresh` is a preference, not a hard cache bypass: Redis (≤30s) → DB marks
    // → bounded live crawl (falls back to cached/DB rows on timeout). This keeps
    // the post-mutation refresh fast while never 504-ing on a slow RH RPC crawl.
    const result = await loadRhClmmLiveForOwner(owner)
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Live load failed',
        positions: [],
        stale: true,
        source: 'error',
        syncedAt: null,
      },
      { status: 500 },
    )
  }
}
