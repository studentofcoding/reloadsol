import { describe, expect, it } from 'vitest'
import {
  outcomeBlockedKeys,
  poolsBlockedByRecentClose,
} from '@/utils/dlmm/reopen-guard'

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

describe('outcomeBlockedKeys (durable re-entry guard)', () => {
  const row = (
    token: string | null,
    pool: string | null,
    exit: string | null,
  ) => ({ token_address: token, pool_address: pool, exit_at: exit })

  it('blocks token and pool keys of a recent closed outcome', () => {
    const { tokenKeys, poolKeys } = outcomeBlockedKeys(
      [row('mintA', 'poolA', iso(now - 10 * 60_000))],
      24 * 60 * 60_000,
    )
    expect(tokenKeys.has('mintA')).toBe(true)
    expect(poolKeys.has('poolA')).toBe(true)
  })

  it('does not block outcomes closed before the cooldown window', () => {
    const { tokenKeys, poolKeys } = outcomeBlockedKeys(
      [row('mintA', 'poolA', iso(now - 2 * 24 * 60 * 60_000))],
      24 * 60 * 60_000,
    )
    expect(tokenKeys.has('mintA')).toBe(false)
    expect(poolKeys.has('poolA')).toBe(false)
  })

  it('uses created_at as a fallback close time', () => {
    const { poolKeys } = outcomeBlockedKeys(
      [{ token_address: null, pool_address: 'poolB', exit_at: null, created_at: iso(now - 5 * 60_000) }],
      24 * 60 * 60_000,
    )
    expect(poolKeys.has('poolB')).toBe(true)
  })

  it('drops rows with no close/created timestamp', () => {
    const { tokenKeys, poolKeys } = outcomeBlockedKeys(
      [row('mintA', 'poolA', null), { token_address: null, pool_address: null, exit_at: null }],
      24 * 60 * 60_000,
    )
    expect(tokenKeys.size).toBe(0)
    expect(poolKeys.size).toBe(0)
  })
})
