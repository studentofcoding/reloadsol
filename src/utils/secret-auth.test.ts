import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  connection: vi.fn(async () => undefined),
}))
vi.mock('@/utils/db', () => ({ query: vi.fn(async () => ({ rows: [] })), default: {} }))
vi.mock('@/utils/unified-logger', async (orig) => ({
  ...(await orig<typeof import('@/utils/unified-logger')>()),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const { firstConfiguredSecret, secretsMatch } = await import('@/utils/secret-auth')
const { isServiceAuthorizedRequest, enforceApiAccess } = await import('@/utils/api-auth')
const { isAuthorizedRequest, isDlmmApiAuthorized, DLMM_CONFIG } = await import('@/utils/dlmm/config')
const { isSocialIngestAuthorized, isSocialRollupAuthorized, isSocialWalletPollAuthorized } =
  await import('@/utils/social/config')

// Built at runtime so this file itself carries no committed secret literal.
const OLD_CRON_DEFAULT = ['r3l0ads0l', 'trending'].join('-')
const OLD_DLMM_DEFAULT = ['early', 'trencher'].join('')

const ENV = [
  'TRENDING_TRACKER_SECRET',
  'DLMM_SCREEN_SECRET',
  'DLMM_MANAGE_SECRET',
  'NOTIFICATION_SECRET_KEY',
  'PNL_UPDATE_SECRET',
  'PNL_UPDATE_TOKEN',
  'DLMM_API_PASSWORD',
  'LOGS_CLEAR_AUTH',
  'SOCIAL_INGEST_SECRET',
  'SOCIAL_ROLLUP_SECRET',
  'GMGN_SIM_TRACK_SECRET',
  'SIGNALS_SIM_TRACK_SECRET',
  'MCAP_TRACKER_SIM_TRACK_SECRET',
  'GMGN_ACTIVITY_POLL_SECRET',
  'DLMM_SIM_TRACK_SECRET',
  'STRATEGY_REPORT_SECRET',
] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('secret helpers', () => {
  it('firstConfiguredSecret has no default and skips blanks', () => {
    expect(firstConfiguredSecret(undefined, '', '  ', null)).toBe('')
    expect(firstConfiguredSecret('', 'a', 'b')).toBe('a')
  })

  it('secretsMatch fails closed on empty/missing on either side', () => {
    expect(secretsMatch('', '')).toBe(false)
    expect(secretsMatch(null, '')).toBe(false)
    expect(secretsMatch('x', '')).toBe(false)
    expect(secretsMatch('', 'x')).toBe(false)
    expect(secretsMatch('x', undefined)).toBe(false)
    expect(secretsMatch('abc', 'abc')).toBe(true)
    expect(secretsMatch('abc', 'abd')).toBe(false)
    expect(secretsMatch('abc', 'abcd')).toBe(false)
  })
})

describe('missing env fails closed', () => {
  it('dlmm/social config helpers reject the old defaults and empty keys', () => {
    expect(DLMM_CONFIG.manageSecret).toBe('')
    expect(DLMM_CONFIG.screenSecret).toBe('')
    expect(DLMM_CONFIG.apiPassword).toBe('')
    for (const guess of [OLD_CRON_DEFAULT, OLD_DLMM_DEFAULT, '', null, undefined]) {
      expect(isAuthorizedRequest(guess)).toBe(false)
      expect(isDlmmApiAuthorized(guess)).toBe(false)
      expect(isSocialIngestAuthorized(guess)).toBe(false)
      expect(isSocialRollupAuthorized(guess)).toBe(false)
      expect(isSocialWalletPollAuthorized(guess)).toBe(false)
    }
    // An explicit empty expected must not turn an empty key into a match.
    expect(isAuthorizedRequest('', '')).toBe(false)
  })

  it('proxy: old literal secrets / empty key / empty password are not service-authorised', () => {
    const mk = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${path}`, init)
    for (const path of [
      `/api/signals/sim-track?key=${OLD_CRON_DEFAULT}`,
      '/api/signals/sim-track?key=',
      '/api/dlmm/positions?password=',
      `/api/dlmm/positions?password=${OLD_DLMM_DEFAULT}`,
    ]) {
      expect(isServiceAuthorizedRequest(mk(path)), path).toBe(false)
    }
    expect(
      isServiceAuthorizedRequest(
        mk('/api/dlmm/positions', { headers: { 'x-dlmm-password': OLD_DLMM_DEFAULT } }),
      ),
    ).toBe(false)
    expect(
      isServiceAuthorizedRequest(
        mk('/api/signals', { headers: { authorization: `Bearer ${OLD_CRON_DEFAULT}` } }),
      ),
    ).toBe(false)
  })

  it('DLMM password only bypasses the proxy on /api/dlmm/*, never on other routes', () => {
    process.env.DLMM_API_PASSWORD = 'pw-for-test'
    const hdr = { headers: { 'x-dlmm-password': 'pw-for-test' } }
    const mk = (path: string) => new NextRequest(`http://localhost${path}`, hdr)
    expect(isServiceAuthorizedRequest(mk('/api/dlmm/positions'))).toBe(true)
    expect(isServiceAuthorizedRequest(mk('/api/signals'))).toBe(false)
    expect(isServiceAuthorizedRequest(mk('/api/shyft/transaction/send_rpc'))).toBe(false)
    expect(enforceApiAccess(mk('/api/signals'))?.status).toBe(401)
  })

  it('configured secrets still work', () => {
    process.env.TRENDING_TRACKER_SECRET = 'cron-secret-for-test'
    expect(
      isServiceAuthorizedRequest(
        new NextRequest('http://localhost/api/signals/sim-track?key=cron-secret-for-test'),
      ),
    ).toBe(true)
  })
})

describe('cron routes reject the old committed secret when the env is unset', () => {
  const mk = (path: string, method: string, key: string | null) =>
    new NextRequest(`http://localhost${path}${key === null ? '' : `?key=${key}`}`, {
      method,
      headers: key ? { authorization: `Bearer ${key}` } : {},
    })

  const routes: [string, string, () => Promise<Record<string, (r: NextRequest) => Promise<Response>>>][] = [
    ['/api/signals/sim-track', 'POST', () => import('@/app/api/signals/sim-track/route') as never],
    ['/api/gmgn/sim-track', 'POST', () => import('@/app/api/gmgn/sim-track/route') as never],
    ['/api/gmgn/radar-digest', 'POST', () => import('@/app/api/gmgn/radar-digest/route') as never],
    ['/api/gmgn/wallet-digger', 'POST', () => import('@/app/api/gmgn/wallet-digger/route') as never],
    ['/api/report-precompute/refresh', 'POST', () => import('@/app/api/report-precompute/refresh/route') as never],
    ['/api/strategies/report-digest', 'POST', () => import('@/app/api/strategies/report-digest/route') as never],
    ['/api/workers/runtime', 'GET', () => import('@/app/api/workers/runtime/route') as never],
    ['/api/trending/track', 'PUT', () => import('@/app/api/trending/track/route') as never],
    ['/api/trending', 'POST', () => import('@/app/api/trending/route') as never],
    ['/api/logs', 'DELETE', () => import('@/app/api/logs/route') as never],
  ]

  it.each(routes)('%s %s -> 401 for the old default, empty key, and no key', async (path, method, load) => {
    const mod = await load()
    const handler = mod[method]
    expect(typeof handler, `${path} exports ${method}`).toBe('function')
    for (const key of [OLD_CRON_DEFAULT, '', null]) {
      const res = await handler(mk(path, method, key))
      expect(res.status, `${path} key=${key === null ? 'none' : key === '' ? 'empty' : 'old-default'}`).toBe(401)
    }
  })
})

describe('no committed secret literals in shipped source', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full)
    }
    return out
  }
  it('src/ contains neither the old cron default nor the old DLMM password default', () => {
    const offenders = walk(join(__dirname, '..'))
      .filter((f) => {
        const s = readFileSync(f, 'utf8')
        return s.includes(OLD_CRON_DEFAULT) || s.includes(OLD_DLMM_DEFAULT) || s.includes('clear-logs-secret')
      })
      .map((f) => f.replace(join(__dirname, '..'), 'src'))
    expect(offenders).toEqual([])
  })
})
