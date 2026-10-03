/**
 * Minimal AWS Signature V4 for S3-compatible object stores (Cloudflare R2).
 *
 * Why hand-rolled: the repo has no AWS SDK and the archive needs exactly four calls (PUT with
 * `If-None-Match: *`, HEAD, GET, ListObjectsV2). A dependency would add ~10 MB to the standalone
 * bundle and a lockfile change for ~120 lines of HMAC. Pure and deterministic given `now`, so the
 * signature is unit-tested against an independently computed vector.
 */
import { createHash, createHmac } from 'node:crypto'

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

/** RFC 3986 encoding as S3 SigV4 requires (everything but A-Z a-z 0-9 - _ . ~). */
export function awsUriEncode(value: string, keepSlash = false): string {
  let out = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === '/')) out += ch
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

export type SigV4Input = {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  host: string
  /** Unencoded absolute path, e.g. `/bucket/evidence/v1/x.ndjson.gz`. */
  path: string
  query?: Record<string, string>
  /** Extra headers to sign (names are lower-cased here). `host`, `x-amz-*` are added for you. */
  headers?: Record<string, string>
  payloadSha256: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
  service?: string
  now: Date
}

export type SigV4Output = {
  /** Full header set to send (includes Authorization, x-amz-date, x-amz-content-sha256). */
  headers: Record<string, string>
  /** Path + canonical query string to append to `https://host`. */
  urlPath: string
  canonicalRequest: string
  stringToSign: string
  signature: string
}

export function amzDate(now: Date): { date: string; stamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { stamp: iso, date: iso.slice(0, 8) }
}

export function signSigV4(input: SigV4Input): SigV4Output {
  const region = input.region ?? 'auto'
  const service = input.service ?? 's3'
  const { stamp, date } = amzDate(input.now)

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim()
  headers.host = input.host
  headers['x-amz-content-sha256'] = input.payloadSha256
  headers['x-amz-date'] = stamp

  const signedNames = Object.keys(headers).sort()
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]}\n`).join('')
  const signedHeaders = signedNames.join(';')

  const canonicalUri = awsUriEncode(input.path, true)
  const queryEntries = Object.entries(input.query ?? {})
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  const canonicalQuery = queryEntries.map(([k, v]) => `${k}=${v}`).join('&')

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join('\n')

  const scope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${input.secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    headers,
    urlPath: canonicalQuery ? `${canonicalUri}?${canonicalQuery}` : canonicalUri,
    canonicalRequest,
    stringToSign,
    signature,
  }
}
