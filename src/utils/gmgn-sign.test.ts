import { generateKeyPairSync, verify as cryptoVerify } from 'crypto'
import { describe, expect, it } from 'vitest'
import { buildGmgnSignMessage, signGmgnMessage } from './gmgn-api'

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
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const message = buildGmgnSignMessage(
      '/v1/trade/follow_wallet',
      { chain: 'sol', client_id: 'x', limit: '1', timestamp: '1' },
      '',
      1,
    )
    const sigB64 = signGmgnMessage(message, pem)
    expect(
      cryptoVerify(null, Buffer.from(message, 'utf-8'), publicKey, Buffer.from(sigB64, 'base64')),
    ).toBe(true)
  })
})
