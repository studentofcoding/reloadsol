import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/app/api/mcap-tracking/join-trending-social', () => ({
  loadTrackerSocialJoinMap: vi.fn(),
}))
vi.mock('@/utils/tracker-flags', () => ({
  isTrackerSocialJoinEnabled: vi.fn(() => true),
}))

import { loadTrackerSocialJoinMap } from '@/app/api/mcap-tracking/join-trending-social'
import { isTrackerSocialJoinEnabled } from '@/utils/tracker-flags'
import { GET, MAX_PRESENCE_MINTS, parsePresenceMints } from './route'

const MINT_A = 'So11111111111111111111111111111111111111112'
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

/** Distinct valid 44-char base58 mints (appending a digit would exceed the cap). */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const mintAt = (i: number) =>
  `So1111111111111111111111111111111111111${BASE58[i % BASE58.length]}`

function req(mints?: string): NextRequest {
  const qs = mints === undefined ? '' : `?mints=${encodeURIComponent(mints)}`
  return new NextRequest(`http://localhost/api/tokens/presence${qs}`)
}

beforeEach(() => {
  vi.mocked(loadTrackerSocialJoinMap).mockReset()
  vi.mocked(isTrackerSocialJoinEnabled).mockReturnValue(true)
})

describe('parsePresenceMints', () => {
  it('dedupes and drops non-sol junk', () => {
    expect(parsePresenceMints(`${MINT_A}, ${MINT_A} ,not-a-mint,, 0xdeadbeef`)).toEqual([MINT_A])
  })

  it('caps the request', () => {
    const mints = Array.from({ length: 40 }, (_, i) => mintAt(i))
    expect(parsePresenceMints(mints.join(','), 10)).toHaveLength(10)
  })

  it('returns nothing for an empty or missing param', () => {
    expect(parsePresenceMints(null)).toEqual([])
    expect(parsePresenceMints('')).toEqual([])
  })

  it('defaults the cap to MAX_PRESENCE_MINTS', () => {
    expect(MAX_PRESENCE_MINTS).toBe(200)
  })
})

describe('GET /api/tokens/presence', () => {
  it('returns only mints that actually have presence', async () => {
    vi.mocked(loadTrackerSocialJoinMap).mockResolvedValue(
      new Map([
        [MINT_A, { social: { twitter: '@a', website: 'a.com' } }],
        [MINT_B, { social: undefined }],
      ]) as never,
    )

    const body = await (await GET(req(`${MINT_A},${MINT_B}`))).json()

    expect(body.success).toBe(true)
    expect(body.presence).toEqual({ [MINT_A]: { twitter: '@a', website: 'a.com' } })
    expect(body.presence[MINT_B]).toBeUndefined()
    expect(vi.mocked(loadTrackerSocialJoinMap)).toHaveBeenCalledWith({ chain: 'sol' })
  })

  it('is fail-soft when the join throws', async () => {
    vi.mocked(loadTrackerSocialJoinMap).mockRejectedValue(new Error('gmgn down'))

    const response = await GET(req(MINT_A))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, presence: {} })
  })

  it('skips the upstream entirely when the mint param is empty', async () => {
    const body = await (await GET(req())).json()
    expect(body.presence).toEqual({})
    expect(vi.mocked(loadTrackerSocialJoinMap)).not.toHaveBeenCalled()
  })

  it('serves nothing when the join flag is off', async () => {
    vi.mocked(isTrackerSocialJoinEnabled).mockReturnValue(false)

    const body = await (await GET(req(MINT_A))).json()
    expect(body.presence).toEqual({})
    expect(vi.mocked(loadTrackerSocialJoinMap)).not.toHaveBeenCalled()
  })
})
