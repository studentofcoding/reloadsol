/**
 * Cloudflare R2 (S3 API) object store used by the evidence archive.
 *
 * Append-only by construction: `putIfAbsent` sends `If-None-Match: *`, so R2 answers 412 for a key that
 * already exists and the existing bytes are never touched. There is deliberately no overwrite and no
 * delete in this interface.
 *
 * No credentials are committed. Everything comes from the environment (names below); when any
 * required name is missing `r2ConfigFromEnv` returns `null` and `r2MissingEnv` names what to add.
 */
import { sha256Hex, signSigV4 } from '@/utils/s3-sigv4'

export const R2_REQUIRED_ENV = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
] as const

export type R2Config = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Host without scheme. Default `<account>.r2.cloudflarestorage.com`; `R2_ENDPOINT` overrides (tests, EU jurisdiction). */
  host: string
}

type EnvLike = Record<string, string | undefined>

export function r2MissingEnv(env: EnvLike = process.env): string[] {
  return R2_REQUIRED_ENV.filter((name) => !env[name]?.trim())
}

export function r2ConfigFromEnv(env: EnvLike = process.env): R2Config | null {
  if (r2MissingEnv(env).length > 0) return null
  const accountId = env.R2_ACCOUNT_ID!.trim()
  const endpoint = env.R2_ENDPOINT?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return {
    accountId,
    accessKeyId: env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!.trim(),
    bucket: env.R2_BUCKET!.trim(),
    host: endpoint || `${accountId}.r2.cloudflarestorage.com`,
  }
}

export type PutResult = { created: boolean }
export type HeadResult = { size: number; sha256: string | null }

export interface ObjectStore {
  /** Create `key` only if it does not exist. `created:false` = it already existed and was NOT modified. */
  putIfAbsent(
    key: string,
    body: Buffer,
    opts?: { contentType?: string; sha256?: string },
  ): Promise<PutResult>
  head(key: string): Promise<HeadResult | null>
  get(key: string): Promise<Buffer | null>
  list(prefix: string): Promise<string[]>
}

export class ObjectStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ObjectStoreError'
  }
}

const REQUEST_TIMEOUT_MS = 60_000

export function createR2Store(
  cfg: R2Config,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): ObjectStore {
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())

  async function send(
    method: 'GET' | 'PUT' | 'HEAD',
    key: string,
    opts: {
      body?: Buffer
      query?: Record<string, string>
      headers?: Record<string, string>
    } = {},
  ): Promise<Response> {
    const path = key ? `/${cfg.bucket}/${key}` : `/${cfg.bucket}`
    const payloadSha256 = sha256Hex(opts.body ?? '')
    const signed = signSigV4({
      method,
      host: cfg.host,
      path,
      query: opts.query,
      headers: opts.headers,
      payloadSha256,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      now: now(),
    })
    const { host: _host, ...sendHeaders } = signed.headers
    void _host
    return doFetch(`https://${cfg.host}${signed.urlPath}`, {
      method,
      headers: sendHeaders,
      body: opts.body ? new Uint8Array(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  return {
    async putIfAbsent(key, body, opts = {}) {
      const headers: Record<string, string> = {
        'if-none-match': '*',
        'content-type': opts.contentType ?? 'application/octet-stream',
        'x-amz-meta-sha256': opts.sha256 ?? sha256Hex(body),
      }
      const res = await send('PUT', key, { body, headers })
      if (res.status === 412) return { created: false }
      if (res.status >= 200 && res.status < 300) return { created: true }
      throw new ObjectStoreError(`R2 PUT ${key} -> ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
    },

    async head(key) {
      const res = await send('HEAD', key)
      if (res.status === 404) return null
      if (!res.ok) throw new ObjectStoreError(`R2 HEAD ${key} -> ${res.status}`, res.status)
      return {
        size: Number(res.headers.get('content-length') ?? 0),
        sha256: res.headers.get('x-amz-meta-sha256'),
      }
    },

    async get(key) {
      const res = await send('GET', key)
      if (res.status === 404) return null
      if (!res.ok) throw new ObjectStoreError(`R2 GET ${key} -> ${res.status}`, res.status)
      return Buffer.from(await res.arrayBuffer())
    },

    async list(prefix) {
      const keys: string[] = []
      let token: string | undefined
      for (let page = 0; page < 1000; page += 1) {
        const query: Record<string, string> = { 'list-type': '2', prefix }
        if (token) query['continuation-token'] = token
        const res = await send('GET', '', { query })
        if (!res.ok) throw new ObjectStoreError(`R2 LIST ${prefix} -> ${res.status}`, res.status)
        const xml = await res.text()
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]))
        const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)
        if (!next || !/<IsTruncated>true<\/IsTruncated>/.test(xml)) break
        token = decodeXml(next[1])
      }
      return keys
    },
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
