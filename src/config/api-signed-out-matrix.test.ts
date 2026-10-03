import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { enforceApiAccess, tierEnforceMode } from '@/utils/api-auth'

/**
 * Every route under src/app/api, every exported method: what a SIGNED-OUT, key-less caller gets from the proxy.
 * `pass` = the proxy lets it through (public, or self-authenticating in the handler); `401` = blocked.
 *
 * The expected map lives in api-signed-out-matrix.json. A new route, a changed tier, or a removed route fails this
 * test until the JSON is regenerated on purpose:  UPDATE_MATRIX=1 npx vitest run src/config/api-signed-out-matrix
 * so every exposure change shows up as a reviewable diff.
 */

const API_DIR = join(process.cwd(), 'src', 'app', 'api')
const MATRIX_FILE = join(process.cwd(), 'src', 'config', 'api-signed-out-matrix.json')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name === 'route.ts' || name === 'route.tsx') out.push(p)
  }
  return out
}

function inventory(): { path: string; method: string }[] {
  const rows: { path: string; method: string }[] = []
  for (const file of walk(API_DIR)) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(join(process.cwd(), 'src', 'app'), file).split(sep)
    rel.pop() // route.ts
    const path = '/' + rel.map((seg) => (/^\[.+\]$/.test(seg) ? 'x' : seg)).join('/')
    for (const m of METHODS) {
      const re = new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b|export\\s+const\\s+${m}\\b`)
      if (re.test(src)) rows.push({ path, method: m })
    }
  }
  return rows.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method))
}

function signedOut(path: string, method: string): 'pass' | '401' {
  const req = new NextRequest(`http://localhost${path}`, { method })
  const res = enforceApiAccess(req)
  return res ? (String(res.status) as '401') : 'pass'
}

const SECRET = 'matrix-test-secret'

beforeEach(() => {
  // enforce mode logs every block; keep test output quiet (the log-mode test installs its own spy)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('signed-out route matrix', () => {
  const rows = inventory()

  it('finds the route inventory', () => {
    expect(rows.length).toBeGreaterThan(150)
  })

  it('every route + method gets the documented signed-out status', () => {
    const actual: Record<string, string> = {}
    for (const r of rows) actual[`${r.method} ${r.path}`] = signedOut(r.path, r.method)

    if (process.env.UPDATE_MATRIX === '1' || !existsSync(MATRIX_FILE)) {
      writeFileSync(MATRIX_FILE, JSON.stringify(actual, null, 2) + '\n')
    }
    const expected = JSON.parse(readFileSync(MATRIX_FILE, 'utf8')) as Record<string, string>

    const added = Object.keys(actual).filter((k) => !(k in expected))
    const removed = Object.keys(expected).filter((k) => !(k in actual))
    const changed = Object.keys(actual).filter((k) => k in expected && expected[k] !== actual[k])
    expect({ added, removed, changed: changed.map((k) => `${k}: ${expected[k]} -> ${actual[k]}`) }).toEqual({
      added: [],
      removed: [],
      changed: [],
    })
  })

  it('health and the read APIs the signed-out UI needs stay reachable', () => {
    const mustPass: [string, string][] = [
      ['/api/health', 'GET'],
      ['/api/regime/climate', 'GET'],
      ['/api/rh/config', 'GET'],
      ['/api/gmgn/bound-wallets', 'GET'],
      ['/api/ethprice', 'GET'],
      ['/api/auth/wallet/session', 'GET'],
      ['/api/auth/wallet/session', 'POST'],
    ]
    for (const [p, m] of mustPass) expect(signedOut(p, m), `${m} ${p}`).toBe('pass')
  })

  it('wallet / dev routes are blocked signed-out, including rh/rpc and kyber/build', () => {
    const mustBlock: [string, string][] = [
      ['/api/rh/rpc', 'POST'],
      ['/api/kyber/build', 'POST'],
      ['/api/kyber/routes', 'GET'],
      ['/api/shyft/transaction/send_rpc', 'POST'],
      ['/api/gmgn/trade/swap', 'POST'],
      ['/api/signals', 'GET'],
      ['/api/dlmm/positions', 'GET'],
      ['/api/mcap-tracking', 'GET'],
    ]
    for (const [p, m] of mustBlock) expect(signedOut(p, m), `${m} ${p}`).toBe('401')
  })

  it('a server self-fetch with the service secret passes every tier', () => {
    vi.stubEnv('TRENDING_TRACKER_SECRET', SECRET)
    for (const r of rows) {
      const req = new NextRequest(`http://web:3000${r.path}`, {
        method: r.method,
        headers: { authorization: `Bearer ${SECRET}` },
      })
      expect(enforceApiAccess(req), `${r.method} ${r.path}`).toBeNull()
    }
  })

  it('a wrong secret does not pass', () => {
    vi.stubEnv('TRENDING_TRACKER_SECRET', SECRET)
    const req = new NextRequest('http://web:3000/api/signals', {
      method: 'GET',
      headers: { authorization: 'Bearer nope' },
    })
    expect(enforceApiAccess(req)?.status).toBe(401)
  })
})

describe('API_TIER_ENFORCE modes', () => {
  it('parses the flag (default enforce)', () => {
    expect(tierEnforceMode({})).toBe('enforce')
    expect(tierEnforceMode({ API_TIER_ENFORCE: '1' })).toBe('enforce')
    expect(tierEnforceMode({ API_TIER_ENFORCE: 'log' })).toBe('log')
    expect(tierEnforceMode({ API_TIER_ENFORCE: 'LOG ' })).toBe('log')
    expect(tierEnforceMode({ API_TIER_ENFORCE: '0' })).toBe('off')
    expect(tierEnforceMode({ API_TIER_ENFORCE: 'off' })).toBe('off')
  })

  it('log mode never blocks but logs the would-be 401 with route and caller (no query string)', () => {
    vi.stubEnv('API_TIER_ENFORCE', 'log')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const req = new NextRequest('http://localhost/api/signals?key=SHOULD-NOT-APPEAR', {
      method: 'GET',
      headers: { referer: 'https://reloadsol.app/buy?x=1', 'user-agent': 'vitest' },
    })
    expect(enforceApiAccess(req)).toBeNull()
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[api-tier]'))
    expect(line).toBeTruthy()
    expect(line).toContain('"action":"would_block"')
    expect(line).toContain('"path":"/api/signals"')
    expect(line).toContain('"referer":"/buy"')
    expect(line).not.toContain('SHOULD-NOT-APPEAR')
    warn.mockRestore()
  })

  it('off mode (kill switch) disables the proxy checks', () => {
    vi.stubEnv('API_TIER_ENFORCE', '0')
    const req = new NextRequest('http://localhost/api/dlmm/positions', { method: 'GET' })
    expect(enforceApiAccess(req)).toBeNull()
  })

  it('enforce is the default when the flag is unset', () => {
    vi.stubEnv('API_TIER_ENFORCE', '')
    const req = new NextRequest('http://localhost/api/dlmm/positions', { method: 'GET' })
    expect(enforceApiAccess(req)?.status).toBe(401)
  })
})
