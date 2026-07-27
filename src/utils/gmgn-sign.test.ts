import { generateKeyPairSync, verify as cryptoVerify } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  buildGmgnSignMessage,
  GmgnApiError,
  normalizeGmgnPrivateKeyPem,
  signGmgnMessage,
  unwrapApiData,
} from './gmgn-api'

function freshEd25519Pem(): { privatePem: string; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  }
}

describe('unwrapApiData', () => {
  it('unwraps the single envelope used by /v1/token/info', () => {
    const info = { address: '0xabc', symbol: 'HOOD', price: 1.5 }
    expect(unwrapApiData({ code: 0, data: info, message: '', reason: '' })).toEqual(info)
  })

  it('unwraps the double envelope used by /v1/market/rank', () => {
    const rank = [{ address: '0xabc', symbol: 'HOOD' }]
    expect(
      unwrapApiData({
        code: 0,
        data: { code: 0, data: { rank }, message: 'success', reason: '' },
      }),
    ).toEqual({ rank })
  })

  it('throws on an error code carried by the inner envelope', () => {
    expect(() =>
      unwrapApiData({
        code: 0,
        data: { code: 50001, data: null, message: 'chain not supported', reason: '' },
      }),
    ).toThrow(/chain not supported/)
  })

  it('throws on an error code at the outer envelope', () => {
    expect(() => unwrapApiData({ code: 429, msg: 'rate limited', data: null })).toThrow(
      GmgnApiError,
    )
  })

  it('keeps a payload whose own fields include code but is not an envelope', () => {
    const payload = { code: 200, symbol: 'HOOD' }
    expect(unwrapApiData({ code: 0, data: payload })).toEqual(payload)
  })
})

describe('buildGmgnSignMessage', () => {
  it('matches gmgn-cli sorted query format', () => {
    const msg = buildGmgnSignMessage(
      '/v1/trade/follow_wallet',
      {
        chain: 'sol',
        client_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        limit: '50',
        timestamp: '1700000000',
      },
      '',
      1_700_000_000,
    )
    expect(msg).toBe(
      '/v1/trade/follow_wallet:chain=sol&client_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&limit=50&timestamp=1700000000::1700000000',
    )
  })

  it('Ed25519 signature verifies for the message bytes', () => {
    const { privatePem, publicKey } = freshEd25519Pem()
    const message = buildGmgnSignMessage(
      '/v1/trade/follow_wallet',
      { chain: 'sol', client_id: 'x', limit: '1', timestamp: '1' },
      '',
      1,
    )
    const sigB64 = signGmgnMessage(message, privatePem)
    expect(
      cryptoVerify(null, Buffer.from(message, 'utf-8'), publicKey, Buffer.from(sigB64, 'base64')),
    ).toBe(true)
  })
})

describe('normalizeGmgnPrivateKeyPem', () => {
  it('unescapes one-line PEM and signs', () => {
    const { privatePem, publicKey } = freshEd25519Pem()
    const escaped = privatePem.replace(/\n/g, '\\n')
    const normalized = normalizeGmgnPrivateKeyPem(escaped)
    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----')
    expect(normalized).not.toContain('\\n')
    const message = 'hello'
    const sig = signGmgnMessage(message, escaped)
    expect(
      cryptoVerify(null, Buffer.from(message, 'utf-8'), publicKey, Buffer.from(sig, 'base64')),
    ).toBe(true)
  })

  it('extracts private block from keypair.pem-style dual content', () => {
    const { privatePem, publicKey } = freshEd25519Pem()
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const dual = `# Private Key\n${privatePem}\n# Public Key\n${pub}\n`
    const normalized = normalizeGmgnPrivateKeyPem(dual)
    expect(normalized).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    expect(normalized).not.toContain('BEGIN PUBLIC KEY')
    const message = 'dual-block'
    const sig = signGmgnMessage(message, dual)
    expect(
      cryptoVerify(null, Buffer.from(message, 'utf-8'), publicKey, Buffer.from(sig, 'base64')),
    ).toBe(true)
  })

  it('strips wrapping quotes', () => {
    const { privatePem } = freshEd25519Pem()
    const quoted = `"${privatePem.replace(/\n/g, '\\n')}"`
    expect(normalizeGmgnPrivateKeyPem(quoted)).toContain('-----BEGIN PRIVATE KEY-----')
  })

  it('throws a clear error for OpenSSH / garbage (not raw decoder only)', () => {
    expect(() =>
      normalizeGmgnPrivateKeyPem('-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----'),
    ).toThrow(GmgnApiError)
    expect(() => normalizeGmgnPrivateKeyPem('not-a-key')).toThrow(/PKCS#8 PEM/)
  })
})
