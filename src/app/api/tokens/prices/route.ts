import { NextRequest, NextResponse, connection } from 'next/server'
import { getUsdPrices } from '@/utils/usd-prices'

const MAX_TOKENS_PER_HTTP = 100
const COALESCE_MS = 100

type PendingRequest = {
  tokens: string[]
  resolve: (value: { prices: Record<string, number>; unpriced: string[] }) => void
  reject: (error: Error) => void
}

const pendingRequests: PendingRequest[] = []
let batchTimeout: ReturnType<typeof setTimeout> | null = null

function processBatchedRequests() {
  if (pendingRequests.length === 0) return

  const allTokens = new Set<string>()
  pendingRequests.forEach((req) => {
    req.tokens.forEach((token) => allTokens.add(token))
  })
  const uniqueTokens = Array.from(allTokens)
  const requestsToResolve = [...pendingRequests]
  pendingRequests.length = 0

  Promise.resolve()
    .then(async () => {
      const { prices, unpriced } = await getUsdPrices(uniqueTokens)
      const unpricedSet = new Set(unpriced)
      requestsToResolve.forEach((request) => {
        const requestPrices: Record<string, number> = {}
        const requestUnpriced: string[] = []
        request.tokens.forEach((token) => {
          if (token in prices) requestPrices[token] = prices[token]
          else if (unpricedSet.has(token)) requestUnpriced.push(token)
        })
        request.resolve({ prices: requestPrices, unpriced: requestUnpriced })
      })
    })
    .catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error('Price fetch failed')
      requestsToResolve.forEach((request) => request.reject(err))
    })
}

function addToBatch(
  tokens: string[],
): Promise<{ prices: Record<string, number>; unpriced: string[] }> {
  return new Promise((resolve, reject) => {
    pendingRequests.push({ tokens, resolve, reject })
    if (batchTimeout) clearTimeout(batchTimeout)
    batchTimeout = setTimeout(processBatchedRequests, COALESCE_MS)
  })
}

function validMints(tokens: unknown): string[] {
  if (!Array.isArray(tokens)) return []
  return tokens.filter(
    (token): token is string =>
      typeof token === 'string' && token.length >= 32 && token.length <= 44,
  )
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const tokens = validMints(body?.tokens)

    if (!Array.isArray(body?.tokens)) {
      return NextResponse.json(
        { error: 'Invalid request. Expected { tokens: string[] }' },
        { status: 400 },
      )
    }

    if (tokens.length === 0) {
      return NextResponse.json({ prices: {}, unpriced: [] })
    }

    if (tokens.length > MAX_TOKENS_PER_HTTP) {
      return NextResponse.json(
        { error: `Too many tokens. Maximum ${MAX_TOKENS_PER_HTTP} per request.` },
        { status: 400 },
      )
    }

    const { prices, unpriced } = await addToBatch(tokens)
    return NextResponse.json(
      { prices, unpriced },
      {
        status: 200,
        headers: { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=30' },
      },
    )
  } catch (error) {
    console.error('Price API error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest) {
  await connection()
  const { searchParams } = new URL(request.url)
  const tokensParam = searchParams.get('tokens') || searchParams.get('token')
  const tokens = tokensParam ? tokensParam.split(',').filter(Boolean) : []

  if (tokens.length === 0) {
    return NextResponse.json({ error: 'No tokens specified' }, { status: 400 })
  }

  if (tokens.length > MAX_TOKENS_PER_HTTP) {
    return NextResponse.json(
      { error: `Too many tokens. Maximum ${MAX_TOKENS_PER_HTTP} per request.` },
      { status: 400 },
    )
  }

  try {
    const { prices, unpriced } = await addToBatch(tokens)
    return NextResponse.json({ prices, unpriced })
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to fetch prices',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}
