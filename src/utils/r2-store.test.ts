import { describe, expect, it, vi } from 'vitest'
import { createR2Store, r2ConfigFromEnv, r2MissingEnv } from './r2-store'

const ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'AKID',
  R2_SECRET_ACCESS_KEY: 'SECRET',
  R2_BUCKET: 'bkt',
}

describe('r2ConfigFromEnv', () => {
  it('names every missing variable and returns null', () => {
    expect(r2MissingEnv({})).toEqual(['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'])
    expect(r2ConfigFromEnv({ R2_ACCOUNT_ID: 'a' })).toBeNull()
  })
  it('derives the S3 host from the account id and honours R2_ENDPOINT', () => {
    expect(r2ConfigFromEnv(ENV)?.host).toBe('acct.r2.cloudflarestorage.com')
    expect(r2ConfigFromEnv({ ...ENV, R2_ENDPOINT: 'https://eu.example.com/' })?.host).toBe('eu.example.com')
  })
})

describe('createR2Store', () => {
  const cfg = r2ConfigFromEnv(ENV)!
  const fixedNow = () => new Date('2026-10-04T00:00:00Z')

  it('PUTs with If-None-Match: * and reports created', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
    const store = createR2Store(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow })
    const res = await store.putIfAbsent('p/k.gz', Buffer.from('abc'), { contentType: 'application/gzip' })
    expect(res.created).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://acct.r2.cloudflarestorage.com/bkt/p/k.gz')
    const headers = init.headers as Record<string, string>
    expect(headers['if-none-match']).toBe('*')
    expect(headers['x-amz-meta-sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20261004\/auto\/s3\/aws4_request/)
    expect(JSON.stringify(init)).not.toContain('SECRET')
  })

  it('treats 412 as "already exists, not modified" (append-only)', async () => {
    const fetchImpl = vi.fn(async () => new Response('PreconditionFailed', { status: 412 }))
    const store = createR2Store(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow })
    await expect(store.putIfAbsent('k', Buffer.from('x'))).resolves.toEqual({ created: false })
  })

  it('throws on other failures without leaking secrets', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const store = createR2Store(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow })
    const err = (await store.putIfAbsent('k', Buffer.from('x')).catch((e) => e)) as Error
    expect(String(err.message)).toContain('500')
    expect(String(err.message)).not.toContain('SECRET')
  })

  it('HEAD returns size + stored sha256, null on 404', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'content-length': '12', 'x-amz-meta-sha256': 'ab' } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    const store = createR2Store(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow })
    await expect(store.head('k')).resolves.toEqual({ size: 12, sha256: 'ab' })
    await expect(store.head('k')).resolves.toBeNull()
  })

  it('lists across continuation tokens', async () => {
    const page = (keys: string[], next?: string) =>
      `<ListBucketResult><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${keys
        .map((k) => `<Contents><Key>${k}</Key></Contents>`)
        .join('')}${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(page(['a/1', 'a/2'], 'tok'), { status: 200 }))
      .mockResolvedValueOnce(new Response(page(['a/3']), { status: 200 }))
    const store = createR2Store(cfg, { fetchImpl: fetchImpl as unknown as typeof fetch, now: fixedNow })
    await expect(store.list('a/')).resolves.toEqual(['a/1', 'a/2', 'a/3'])
    expect(String(fetchImpl.mock.calls[1][0])).toContain('continuation-token=tok')
  })
})
