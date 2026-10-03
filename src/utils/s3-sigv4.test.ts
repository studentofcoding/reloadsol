import { describe, expect, it } from 'vitest'
import { awsUriEncode, signSigV4, sha256Hex } from './s3-sigv4'

describe('signSigV4', () => {
  it('reproduces the AWS documented "GET Object" signature vector', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (Example: GET Object)
    const out = signSigV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    })
    expect(out.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
    expect(out.headers.authorization).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb8',
    )
  })

  it('signs the If-None-Match header it will send', () => {
    const out = signSigV4({
      method: 'PUT',
      host: 'acct.r2.cloudflarestorage.com',
      path: '/bucket/a/b.ndjson.gz',
      headers: { 'If-None-Match': '*' },
      payloadSha256: sha256Hex('x'),
      accessKeyId: 'k',
      secretAccessKey: 's',
      now: new Date('2026-10-04T00:00:00Z'),
    })
    expect(out.headers['if-none-match']).toBe('*')
    expect(out.headers.authorization).toMatch(/SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date/)
    expect(out.canonicalRequest.split('\n')[0]).toBe('PUT')
  })

  it('sorts and encodes the query string', () => {
    const out = signSigV4({
      method: 'GET',
      host: 'h',
      path: '/b',
      query: { prefix: 'a b/c', 'list-type': '2' },
      payloadSha256: sha256Hex(''),
      accessKeyId: 'k',
      secretAccessKey: 's',
      now: new Date('2026-10-04T00:00:00Z'),
    })
    expect(out.urlPath).toBe('/b?list-type=2&prefix=a%20b%2Fc')
  })

  it('percent-encodes like AWS (= and spaces, keeps slashes in paths)', () => {
    expect(awsUriEncode('dt=2026-10-02')).toBe('dt%3D2026-10-02')
    expect(awsUriEncode('a/b c', true)).toBe('a/b%20c')
  })
})
