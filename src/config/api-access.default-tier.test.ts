import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_API_ACCESS_TIER,
  getApiAccessTier,
  SELF_AUTH_API_PREFIXES,
} from './api-access'
import { enforceApiAccess } from '@/utils/api-auth'
import {
  createWalletSession,
  serializeWalletSession,
  WALLET_SESSION_COOKIE,
} from '@/utils/wallet-session'

const ENV_KEYS = [
  'TRENDING_TRACKER_SECRET',
  'DLMM_SCREEN_SECRET',
  'DLMM_MANAGE_SECRET',
  'NOTIFICATION_SECRET_KEY',
  'PNL_UPDATE_SECRET',
  'PNL_UPDATE_TOKEN',
  'DLMM_API_PASSWORD',
  'WALLET_SESSION_SECRET',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  process.env.WALLET_SESSION_SECRET = 'test-session-secret'
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function req(path: string, method = 'GET', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, { method, headers })
}

function withSession(dev: boolean): Record<string, string> {
  const payload = { ...createWalletSession('So11111111111111111111111111111111111111112'), dev }
  return { cookie: `${WALLET_SESSION_COOKIE}=${serializeWalletSession(payload)}` }
}

/** Routes that must keep working for signed-out visitors (landing, header, insight strip, health probes). */
const STILL_PUBLIC: [string, string][] = [
  ['/api/health', 'GET'],
  ['/api/health/ready', 'GET'],
  ['/api/auth/nonce', 'POST'],
  ['/api/solprice', 'GET'],
  ['/api/rpc', 'POST'],
  ['/api/tokens/search', 'GET'],
  ['/api/jupiter/price', 'GET'],
  ['/api/providers/status', 'GET'],
  ['/api/trade/health', 'GET'],
  ['/api/logs', 'POST'],
  ['/api/regime/climate', 'GET'],
  ['/api/gmgn/bound-wallets', 'GET'],
  ['/api/rh/config', 'GET'],
  ['/api/ethprice', 'GET'],
  ['/api/scout/data-public', 'GET'],
  ['/api/trending/filtered', 'GET'],
  ['/api/trending/prices', 'GET'],
  ['/api/gmgn/trending/filtered', 'GET'],
]

/** Previously 'open' routes that now require a wallet session. */
const NOW_WALLET: [string, string][] = [
  ['/api/shyft/transaction/send_rpc', 'POST'],
  ['/api/shyft/transaction/send_txn', 'POST'],
  ['/api/shyft/transaction/send_many_txns', 'POST'],
  ['/api/shyft/wallet/all_tokens', 'GET'],
  ['/api/rh/rpc', 'POST'],
  ['/api/solanatracker/send', 'POST'],
  ['/api/solanatracker/swap', 'POST'],
  ['/api/solanatracker/quote', 'GET'],
  ['/api/kyber/build', 'POST'],
  ['/api/kyber/routes', 'GET'],
  ['/api/gmgn/trade/quote', 'POST'],
  ['/api/gmgn/trade/order', 'GET'],
  ['/api/gmgn/roster', 'GET'],
  ['/api/gmgn/wallet/holdings', 'GET'],
  ['/api/sol/portfolio', 'GET'],
  ['/api/rh/wallet-tokens', 'GET'],
  ['/api/scout/data-public/paper', 'POST'],
  ['/api/some/brand-new-route', 'GET'], // unclassified => default tier
]

/** Operator-only: spend from server-held keys or mutate shared state. */
const NOW_DEV: [string, string][] = [
  ['/api/gmgn/trade/swap', 'POST'],
  ['/api/gmgn/roster', 'PATCH'],
  ['/api/sol-arb/scan', 'GET'],
  ['/api/sol-arb/scan', 'POST'],
  ['/api/sol-arb/quote', 'POST'],
  ['/api/pnl/daily', 'GET'],
  ['/api/pnl/ledger', 'GET'],
  ['/api/mcap-patterns/24h', 'GET'],
  ['/api/mcap-patterns/stats', 'GET'],
]

describe('default API tier', () => {
  it('is wallet', () => {
    expect(DEFAULT_API_ACCESS_TIER).toBe('wallet')
    expect(getApiAccessTier('/api/never/heard/of/it', 'GET')).toBe('wallet')
  })

  it.each(STILL_PUBLIC)('%s %s stays public without a session', (path, method) => {
    expect(getApiAccessTier(path, method)).toBe('public')
    expect(enforceApiAccess(req(path, method))).toBeNull()
  })

  it('does not make the paper-notch write path public just because the read feed is', () => {
    expect(getApiAccessTier('/api/scout/data-public/paper', 'GET')).toBe('wallet')
    expect(getApiAccessTier('/api/scout/data-public', 'POST')).toBe('wallet')
  })

  it.each(NOW_WALLET)('%s %s -> 401 without a session, 200-path with one', (path, method) => {
    const denied = enforceApiAccess(req(path, method))
    expect(denied?.status).toBe(401)
    expect(enforceApiAccess(req(path, method, withSession(false)))).toBeNull()
  })

  it.each(NOW_DEV)('%s %s -> 401 without a session and for a non-dev wallet', (path, method) => {
    expect(enforceApiAccess(req(path, method))?.status).toBe(401)
    expect(enforceApiAccess(req(path, method, withSession(false)))?.status).toBe(401)
    expect(enforceApiAccess(req(path, method, withSession(true)))).toBeNull()
  })

  it('still lets the Go cron reach sol-arb/scan with the service secret', () => {
    process.env.TRENDING_TRACKER_SECRET = 'svc-secret'
    expect(enforceApiAccess(req('/api/sol-arb/scan?key=svc-secret'))).toBeNull()
    expect(enforceApiAccess(req('/api/sol-arb/scan?key=wrong'))?.status).toBe(401)
  })

  it('does not accept a key when the secret env is unset (fails closed)', () => {
    expect(enforceApiAccess(req('/api/sol-arb/scan?key=undefined'))?.status).toBe(401)
    expect(enforceApiAccess(req('/api/sol-arb/scan?key='))?.status).toBe(401)
  })

  it.each(SELF_AUTH_API_PREFIXES.map((p) => [p]))(
    'self-authenticating %s is passed through for its own handler check',
    (prefix) => {
      expect(getApiAccessTier(prefix, 'POST')).toBe('open')
      expect(enforceApiAccess(req(prefix, 'POST'))).toBeNull()
    },
  )

  it('keeps Goldsky ingest and rug-signal sub-paths reachable for their own bearer checks', () => {
    expect(enforceApiAccess(req('/api/rh/ledger/ingest', 'POST'))).toBeNull()
    expect(enforceApiAccess(req('/api/rug-signal/verdicts'))).toBeNull()
    expect(enforceApiAccess(req('/api/rug-signal/token'))).toBeNull()
  })
})

describe('route inventory', () => {
  function routeFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) routeFiles(full, out)
      else if (name === 'route.ts') out.push(full)
    }
    return out
  }
  const apiRoot = join(__dirname, '..', 'app', 'api')
  const paths = routeFiles(apiRoot).map(
    (f) => '/api/' + relative(apiRoot, join(f, '..')).split(sep).join('/'),
  )

  it('only an audited list of routes is open to signed-out callers', () => {
    const exposed = paths
      .filter((p) => ['public', 'open'].includes(getApiAccessTier(p.replace(/\[[^\]]+\]/g, 'x'), 'GET')))
      .sort()
    // Adding a route here is a deliberate decision: review that it is read-only/non-sensitive (public)
    // or authenticates itself inside the handler (open). Update this list in the same PR.
    expect(exposed).toMatchInlineSnapshot(`
      [
        "/api/auth/wallet/logout",
        "/api/auth/wallet/session",
        "/api/ethprice",
        "/api/evidence/archive",
        "/api/gmgn/activity-poll",
        "/api/gmgn/bound-wallets",
        "/api/gmgn/radar-digest",
        "/api/gmgn/roster-watch",
        "/api/gmgn/sim-track",
        "/api/gmgn/token-snapshot",
        "/api/gmgn/trending/filtered",
        "/api/gmgn/wallet-digger",
        "/api/health",
        "/api/jupiter/execute",
        "/api/jupiter/lite/quote",
        "/api/jupiter/lite/swap",
        "/api/jupiter/metadata",
        "/api/jupiter/portfolio",
        "/api/jupiter/quote",
        "/api/jupiter/reclaim/craft",
        "/api/logs",
        "/api/logs/stream",
        "/api/mcap-patterns/refresh",
        "/api/mcap-patterns/training-export",
        "/api/metrics/copy",
        "/api/ml/pattern/reload",
        "/api/ohlc/sample",
        "/api/operations/open-report",
        "/api/regime/climate",
        "/api/report-precompute/refresh",
        "/api/rh/config",
        "/api/rh/ledger/ingest",
        "/api/rpc",
        "/api/rpc/config",
        "/api/rpc/diagnostics",
        "/api/rpc/health",
        "/api/rug-signal/calibrate",
        "/api/rug-signal/calibration",
        "/api/rug-signal/separation",
        "/api/rug-signal/shadow",
        "/api/rug-signal/token",
        "/api/rug-signal/verdicts",
        "/api/scout/data-public",
        "/api/sl-tp-monitor",
        "/api/solprice",
        "/api/tokens/presence",
        "/api/tokens/prices",
        "/api/tokens/random",
        "/api/tokens/search",
        "/api/trade/health",
        "/api/trade/pools-test",
        "/api/trending/filtered",
        "/api/trending/prices",
      ]
    `)
  })
})

describe('shyft send routes enforce the wallet session themselves', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    process.env.SHYFT_RPC_URL = 'https://rpc.example.invalid/?api_key=test'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SHYFT_RPC_URL
  })

  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['AAAA'] })

  it('send_rpc: 401 and no upstream call without a session', async () => {
    const { POST } = await import('@/app/api/shyft/transaction/send_rpc/route')
    const res = await POST(new NextRequest('http://localhost/api/shyft/transaction/send_rpc', { method: 'POST', body }))
    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('send_rpc: forwards to the configured Shyft RPC with a session', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'sig' })))
    const { POST } = await import('@/app/api/shyft/transaction/send_rpc/route')
    const res = await POST(
      new NextRequest('http://localhost/api/shyft/transaction/send_rpc', {
        method: 'POST',
        body,
        headers: withSession(false),
      }),
    )
    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://rpc.example.invalid/?api_key=test')
  })

  const POST_ROUTES: [string, () => Promise<{ POST: (r: NextRequest) => Promise<Response> }>][] = [
    ['/api/shyft/transaction/send_txn', () => import('@/app/api/shyft/transaction/send_txn/route')],
    ['/api/shyft/transaction/send_many_txns', () => import('@/app/api/shyft/transaction/send_many_txns/route')],
    ['/api/solanatracker/send', () => import('@/app/api/solanatracker/send/route')],
    ['/api/solanatracker/swap', () => import('@/app/api/solanatracker/swap/route')],
    ['/api/gmgn/trade/swap', () => import('@/app/api/gmgn/trade/swap/route')],
  ]

  it.each(POST_ROUTES)('%s: 401 and no upstream call without a session', async (path, load) => {
    const mod = await load()
    const res = await mod.POST(new NextRequest(`http://localhost${path}`, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('gmgn/roster PATCH: 401 for no session and for a non-dev wallet', async () => {
    const { PATCH } = await import('@/app/api/gmgn/roster/route')
    const mk = (headers?: Record<string, string>) =>
      new NextRequest('http://localhost/api/gmgn/roster', { method: 'PATCH', body: '{}', headers })
    expect((await PATCH(mk())).status).toBe(401)
    expect((await PATCH(mk(withSession(false)))).status).toBe(401)
  })
})
