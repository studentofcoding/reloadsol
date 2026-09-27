/**
 * Authenticated reverse proxy: VPS → this Worker → Durable Object (wnam) → gmgn.ai
 *
 * Why DO: gmgn.ai Cloudflare WAF 403s datacenter egress from SIN (Tencent CVM +
 * CF Workers colocated in SIN). A Durable Object created with locationHint
 * "wnam" performs the upstream fetch from Western North America, which returns 200.
 *
 * Auth: header X-Gmgn-Proxy-Secret must equal env PROXY_SECRET.
 */

import { DurableObject } from 'cloudflare:workers'

type Env = {
  PROXY_SECRET: string
  UPSTREAM_HOST?: string
  GMGN_FETCHER: DurableObjectNamespace<GmgnFetcher>
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

const ALLOWED_PREFIXES = ['/mrwapi/', '/api/v1/', '/vas/api/']

function allowedPath(pathname: string): boolean {
  return ALLOWED_PREFIXES.some((p) => pathname.startsWith(p))
}

export class GmgnFetcher extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const upstreamHost = (this.env.UPSTREAM_HOST || 'https://gmgn.ai').replace(/\/+$/, '')
    const target = `${upstreamHost}${url.pathname}${url.search}`

    const headers = new Headers()
    headers.set('Accept', request.headers.get('Accept') || 'application/json')
    headers.set('User-Agent', BROWSER_UA)
    headers.set('Origin', 'https://gmgn.ai')
    headers.set('Referer', 'https://gmgn.ai/')
    const ct = request.headers.get('Content-Type')
    if (ct) headers.set('Content-Type', ct)

    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: 'follow',
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer()
    }

    const upstream = await fetch(target, init)
    const body = await upstream.arrayBuffer()
    const out = new Headers()
    for (const k of ['content-type', 'cache-control']) {
      const v = upstream.headers.get(k)
      if (v) out.set(k, v)
    }
    out.set('X-Gmgn-Proxy-Status', String(upstream.status))
    out.set('X-Gmgn-Proxy-Cf-Ray', upstream.headers.get('cf-ray') || '')
    out.set('X-Gmgn-Proxy-Via', 'do-wnam')
    return new Response(body, { status: upstream.status, headers: out })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const secret = env.PROXY_SECRET
    if (!secret) {
      return Response.json({ error: 'PROXY_SECRET not configured' }, { status: 500 })
    }
    const got = request.headers.get('X-Gmgn-Proxy-Secret') || ''
    if (got !== secret) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }

    const url = new URL(request.url)
    if (url.pathname === '/_health' || url.pathname === '/') {
      return Response.json({ ok: true, service: 'gmgn-web-proxy', via: 'do-wnam' })
    }

    if (!allowedPath(url.pathname)) {
      return Response.json({ error: 'path not allowed' }, { status: 404 })
    }

    // Stable name so the DO is created once in wnam and reused.
    const id = env.GMGN_FETCHER.idFromName('gmgn-fetch-wnam-v1')
    const stub = env.GMGN_FETCHER.get(id, { locationHint: 'wnam' })

    // Forward method/path/body/headers the DO cares about
    const forwardHeaders = new Headers()
    forwardHeaders.set('Accept', request.headers.get('Accept') || 'application/json')
    const ct = request.headers.get('Content-Type')
    if (ct) forwardHeaders.set('Content-Type', ct)

    const init: RequestInit = {
      method: request.method,
      headers: forwardHeaders,
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer()
    }

    // Path must be preserved for the DO
    const doUrl = new URL(url.pathname + url.search, 'https://do.internal')
    return stub.fetch(new Request(doUrl.toString(), init))
  },
}
