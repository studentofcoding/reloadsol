import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
}))

import { query } from '@/utils/db'
import { lookupFirstDetections, mergeFirstDetection } from './first-detection'

describe('lookupFirstDetections', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset()
  })

  it('returns empty map for no addresses', async () => {
    expect(await lookupFirstDetections([], 'sol')).toEqual(new Map())
    expect(query).not.toHaveBeenCalled()
  })

  it('maps first_seen_at and first_mcap by normalized address', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        {
          token_address: 'So11111111111111111111111111111111111111112',
          first_seen_at: '2026-09-01T03:00:00.000Z',
          first_mcap: 125000,
        },
      ],
      rowCount: 1,
    })
    const map = await lookupFirstDetections(
      ['So11111111111111111111111111111111111111112'],
      'sol',
    )
    expect(
      map.get('So11111111111111111111111111111111111111112'.toLowerCase()),
    ).toEqual({
      firstSeenAt: '2026-09-01T03:00:00.000Z',
      firstMcap: 125000,
    })
  })
})

describe('mergeFirstDetection', () => {
  it('attaches fields when the map has a hit', () => {
    const addr = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    const mixed = '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD'
    const map = new Map([
      [addr, { firstSeenAt: '2026-09-01T03:00:00.000Z', firstMcap: 50_000 }],
    ])
    expect(
      mergeFirstDetection(
        { token_address: mixed, token_symbol: 'X' },
        map,
      ),
    ).toMatchObject({
      first_seen_at: '2026-09-01T03:00:00.000Z',
      first_mcap: 50_000,
    })
  })
})
