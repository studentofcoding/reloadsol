import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/redis-cache', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}))

vi.mock('@/utils/gmgn-api', () => ({
  GmgnApiError: class GmgnApiError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.code = code
    }
  },
  tokenInfo: vi.fn(),
  tokenSecurity: vi.fn(),
}))

vi.mock('@/utils/gmgn-web-multi', () => ({
  usesGmgnWebTokenInfo: vi.fn(() => false),
  fetchGmgnWebMultiTokenInfo: vi.fn(),
  GmgnWebMultiError: class GmgnWebMultiError extends Error {
    code?: string
    constructor(message: string, code?: string) {
      super(message)
      this.name = 'GmgnWebMultiError'
      this.code = code
    }
  },
}))

import { cacheDel, cacheGet, cacheSet } from '@/utils/redis-cache'
import { tokenInfo, tokenSecurity } from '@/utils/gmgn-api'
import {
  fetchGmgnWebMultiTokenInfo,
  GmgnWebMultiError,
  usesGmgnWebTokenInfo,
} from '@/utils/gmgn-web-multi'
import {
  getGmgnTokenSnapshotCached,
  isGmgnSnapshotData,
} from '@/utils/gmgn-snapshot-cache'

describe('isGmgnSnapshotData', () => {
  it('accepts info+security objects', () => {
    expect(
      isGmgnSnapshotData({ info: { symbol: 'X' }, security: { a: 1 } }),
    ).toBe(true)
  })

  it('rejects poisoned HTTP payload shapes', () => {
    expect(
      isGmgnSnapshotData({
        success: true,
        address: 'Mint',
        holders: 1,
        concentrationBanned: false,
      }),
    ).toBe(false)
    expect(isGmgnSnapshotData(null)).toBe(false)
    expect(isGmgnSnapshotData({ info: {}, security: null })).toBe(false)
  })
})

describe('getGmgnTokenSnapshotCached', () => {
  afterEach(() => {
    vi.mocked(cacheGet).mockReset()
    vi.mocked(cacheSet).mockReset()
    vi.mocked(cacheDel).mockReset()
    vi.mocked(tokenInfo).mockReset()
    vi.mocked(tokenSecurity).mockReset()
    vi.mocked(fetchGmgnWebMultiTokenInfo).mockReset()
    vi.mocked(usesGmgnWebTokenInfo).mockReset()
    vi.mocked(usesGmgnWebTokenInfo).mockReturnValue(false)
  })

  it('treats poisoned cache as miss, deletes key, refetches', async () => {
    vi.mocked(cacheGet).mockResolvedValue({
      success: true,
      address: 'MintA',
      holders: 9,
    })
    vi.mocked(tokenInfo).mockResolvedValue({ symbol: 'OK' })
    vi.mocked(tokenSecurity).mockResolvedValue({ is_honeypot: 'no' })

    const data = await getGmgnTokenSnapshotCached('sol', 'MintA')
    expect(cacheDel).toHaveBeenCalled()
    expect(tokenInfo).toHaveBeenCalled()
    expect(data).toEqual({
      info: { symbol: 'OK' },
      security: { is_honeypot: 'no' },
    })
    expect(cacheSet).toHaveBeenCalled()
  })

  it('returns valid cached info/security without upstream', async () => {
    vi.mocked(cacheGet).mockResolvedValue({
      info: { symbol: 'CACHED' },
      security: {},
    })
    const data = await getGmgnTokenSnapshotCached('sol', 'MintB')
    expect(tokenInfo).not.toHaveBeenCalled()
    expect(fetchGmgnWebMultiTokenInfo).not.toHaveBeenCalled()
    expect(data?.info).toEqual({ symbol: 'CACHED' })
  })

  it('uses web multi for sol when the source flag is on', async () => {
    vi.mocked(usesGmgnWebTokenInfo).mockReturnValue(true)
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(fetchGmgnWebMultiTokenInfo).mockResolvedValue([
      {
        address: 'MintA',
        info: { symbol: 'WEB' },
        security: { renounced_mint: true },
      },
    ])

    const data = await getGmgnTokenSnapshotCached('sol', 'MintA')
    expect(fetchGmgnWebMultiTokenInfo).toHaveBeenCalledWith(['MintA'], {
      includeHolderStat: 'if-missing',
    })
    expect(tokenInfo).not.toHaveBeenCalled()
    expect(tokenSecurity).not.toHaveBeenCalled()
    expect(data).toEqual({
      info: { symbol: 'WEB' },
      security: { renounced_mint: true },
    })
    expect(cacheSet).toHaveBeenCalled()
  })

  it('maps a web cooldown to RATE_LIMIT', async () => {
    vi.mocked(usesGmgnWebTokenInfo).mockReturnValue(true)
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(fetchGmgnWebMultiTokenInfo).mockRejectedValue(
      new GmgnWebMultiError('cooldown', 'BLOCKED'),
    )

    await expect(getGmgnTokenSnapshotCached('sol', 'MintA')).rejects.toMatchObject({
      code: 'RATE_LIMIT',
    })
    expect(tokenInfo).not.toHaveBeenCalled()
  })
})
