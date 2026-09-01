import { NextRequest, NextResponse } from 'next/server'
import { getRhRpcUrls } from '@/utils/dlmm/rh-univ2'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
}

/**
 * Server-side proxy for Robinhood Chain (4663) JSON-RPC.
 *
 * Public RH RPCs may not send CORS headers, so browser-side viem public
 * clients cannot call them directly. All reads go through this route; the
 * upstream call happens server-to-server where CORS does not apply. Tries
 * each configured endpoint in order and fails over on error.
 *
 * Cost control (Edge is metered): state-less read methods are served from a
 * short TTL cache keyed by (method, params) so repeated identical reads from
 * pollers/consumers collapse to a single billed upstream request. Each cached
 * response is rewritten with the incoming `id`, so id-mismatch is impossible.
 * Pass `?fresh=1` to force-bypass the cache (e.g. right after a trade).
 */
type RpcRequest = { id?: unknown; method: string; params?: unknown }
type CachedRpc = { jsonrpc?: string; result?: unknown; error?: unknown }

const CACHEABLE_TTL: Record<string, number> = {
  eth_getBalance: 5,
  eth_call: 5,
  eth_getCode: 5,
  eth_getStorageAt: 5,
  eth_getTransactionCount: 5,
  eth_getTransactionByHash: 5,
  eth_getTransactionByBlockHashAndIndex: 5,
  eth_getTransactionByBlockNumberAndIndex: 5,
  eth_getTransactionReceipt: 5,
  eth_getBlockByNumber: 5,
  eth_getBlockByHash: 5,
  eth_getUncleByBlockHashAndIndex: 5,
  eth_getUncleByBlockNumberAndIndex: 5,
  eth_getLogs: 6,
  eth_chainId: 3,
  eth_blockNumber: 3,
  eth_gasPrice: 3,
  eth_maxPriorityFeePerGas: 3,
  eth_syncing: 3,
  net_version: 3,
}

function cacheTtlFor(method: string): number {
  return CACHEABLE_TTL[method] ?? 0
}

function hashKey(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function rpcCacheKey(method: string, params: unknown): string {
  return `rh:rpc:${method}:${hashKey(JSON.stringify(params ?? []))}`
}

function respond(body: string | object, cached = false): NextResponse {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  return new NextResponse(payload, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...(cached ? { 'X-RH-RPC-Cache': 'HIT' } : {}),
    },
  })
}

export async function POST(request: NextRequest) {
  const body = await request.text()
  const bypassCache = request.nextUrl.searchParams.get('fresh') === '1'

  // Only single JSON-RPC read requests are cacheable; batches and anything we
  // can't parse fall through to a plain upstream call.
  let req: RpcRequest | null = null
  try {
    const parsed = JSON.parse(body) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as RpcRequest).method === 'string' &&
      typeof (parsed as { id?: unknown }).id !== 'object'
    ) {
      req = parsed as RpcRequest
    }
  } catch {
    req = null
  }

  const ttl = req && !bypassCache ? cacheTtlFor(req.method) : 0
  const cacheKey = ttl > 0 && req ? rpcCacheKey(req.method, req.params) : null

  if (cacheKey && req) {
    const hit = await cacheGet<CachedRpc>(cacheKey)
    if (hit) {
      return respond({
        jsonrpc: '2.0',
        id: req.id,
        ...(hit.error !== undefined
          ? { error: hit.error }
          : { result: hit.result }),
      }, true)
    }
  }

  const upstreams = getRhRpcUrls()

  let lastError: string | null = null
  for (const upstream of upstreams) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15_000)

      const res = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      const text = await res.text()
      // Only fail over on transport/5xx errors — 4xx responses from a live
      // endpoint (e.g. bad request) should surface as-is.
      if (res.ok || res.status < 500) {
        if (cacheKey && ttl > 0 && text) {
          try {
            const parsedResp = JSON.parse(text) as CachedRpc
            await cacheSet(
              cacheKey,
              {
                jsonrpc: parsedResp.jsonrpc ?? '2.0',
                ...(parsedResp.error !== undefined
                  ? { error: parsedResp.error }
                  : { result: parsedResp.result }),
              } satisfies CachedRpc,
              ttl,
            )
          } catch {
            // not JSON — leave uncached
          }
        }
        return respond(text)
      }
      lastError = `HTTP ${res.status} from ${upstream}: ${text.slice(0, 200)}`
    } catch (err) {
      lastError = `${upstream}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return NextResponse.json(
    {
      error: 'RH RPC request failed',
      details: lastError ?? 'All RH RPC endpoints failed',
    },
    { status: 502, headers: CORS_HEADERS },
  )
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: CORS_HEADERS })
}
