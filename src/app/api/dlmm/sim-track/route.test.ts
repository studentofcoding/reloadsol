import { describe, expect, it } from 'vitest'
import { poolsBlockedByRecentClose } from '@/utils/dlmm/reopen-guard'

const now = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

describe('poolsBlockedByRecentClose', () => {
  it('blocks a pool closed within the cooldown window', () => {
    const blocked = poolsBlockedByRecentClose(
      [
        {
          status: 'closed',
          pool_address: 'poolA',
          closed_at: iso(now - 10 * 60_000),
        },
      ],
      60 * 60_000,
    )
    expect(blocked.has('poolA')).toBe(true)
  })

  it('does not block pools closed before the cooldown window', () => {
    const blocked = poolsBlockedByRecentClose(
      [
        {
          status: 'closed',
          pool_address: 'poolA',
          closed_at: iso(now - 120 * 60_000),
        },
      ],
      60 * 60_000,
    )
    expect(blocked.has('poolA')).toBe(false)
  })

  it('ignores open positions and rows without a close timestamp', () => {
    const blocked = poolsBlockedByRecentClose(
      [
        { status: 'open', pool_address: 'poolA', closed_at: null },
        { status: 'closed', pool_address: 'poolB', closed_at: null },
      ],
      60 * 60_000,
    )
    expect(blocked.size).toBe(0)
  })
})