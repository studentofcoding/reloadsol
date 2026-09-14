import { NextRequest, NextResponse, connection } from 'next/server'
import { toClimateChipPayload } from '@/utils/climateDisplay'
import { fetchClimate } from '@/utils/climateGate'
import {
  buildScoutBffResponse,
  dataPublicFeedUrl,
  parseDataPublicFeed,
  parseScoutChainQuery,
} from '@/utils/data-public-scout'

const FEED_TIMEOUT_MS = 10_000
const NO_STORE = {
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
}

function unknownClimate(now: number, error?: string) {
  return toClimateChipPayload(
    {
      ok: false,
      error,
      fetchedAt: now,
      computedAt: null,
      state: null,
      h: null,
      cascadeVeto: false,
      sizeKind: 'unknown',
      scale: 1,
    },
    { now },
  )
}

export async function GET(req: NextRequest) {
  await connection()
  const now = Date.now()
  const chain = parseScoutChainQuery(req.nextUrl.searchParams.get('chain'))
  if (!chain) {
    return NextResponse.json(
      { ok: false, error: 'chain must be robinhood, solana, or all' },
      { status: 400, headers: NO_STORE },
    )
  }

  const feedChain = chain === 'all' ? 'all' : chain
  const url = new URL(dataPublicFeedUrl())
  url.searchParams.set('chain', feedChain)

  let climateAtEmit = unknownClimate(now)
  try {
    const gate = await fetchClimate({ failClosed: false, now })
    climateAtEmit = toClimateChipPayload(gate, { now })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    climateAtEmit = unknownClimate(now, msg)
  }

  try {
    const upstream = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ReloadSOL-data-public-scout/1.0',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    })
    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `data-public feed HTTP ${upstream.status}`,
          climateAtEmit,
          paperAllowed: false,
        },
        { status: 502, headers: NO_STORE },
      )
    }
    const body: unknown = await upstream.json()
    const parsed = parseDataPublicFeed(body)
    return NextResponse.json(
      buildScoutBffResponse({
        chain,
        rows: parsed.rows,
        meta: parsed.meta,
        climateAtEmit,
      }),
      { headers: NO_STORE },
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        climateAtEmit,
        paperAllowed: false,
      },
      { status: 502, headers: NO_STORE },
    )
  }
}
