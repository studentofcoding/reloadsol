import { describe, expect, it } from 'vitest'
import type { RhClmmLiveRow, RhClmmPosition } from '@/types/dlmm'
import {
  closedClmmKeys,
  mergeClmmOpenPositions,
} from './rh-position-rows'

function mark(
  over: Partial<RhClmmPosition> & Pick<RhClmmPosition, 'id' | 'token_id' | 'protocol'>,
): RhClmmPosition {
  return {
    pool_address: '0xpool',
    pair_label: 'A/B',
    token_address: null,
    deposit_symbol: null,
    owner_address: '0xowner',
    entry_value_usd: 10,
    current_value_usd: 10,
    pnl_pct: 0,
    status: 'open',
    mint_tx: null,
    close_tx: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    closed_at: null,
    ...over,
  }
}

function live(
  over: Partial<RhClmmLiveRow> & Pick<RhClmmLiveRow, 'tokenId' | 'protocol'>,
): RhClmmLiveRow {
  return {
    poolAddress: '0xpool',
    pairLabel: 'A/B',
    symbol0: 'A',
    symbol1: 'B',
    decimals0: 18,
    decimals1: 18,
    valueUsd: 12,
    unclaimedFeesUsd: 0.1,
    inRange: true,
    tickLower: 0,
    tickUpper: 10,
    liquidity: '1',
    tokensOwed0: '0',
    tokensOwed1: '0',
    token0: '0x0',
    token1: '0x1',
    ...over,
  }
}

describe('mergeClmmOpenPositions', () => {
  it('keeps a live NFT that has no DB mark', () => {
    const rows = mergeClmmOpenPositions(
      [],
      [live({ tokenId: '9', protocol: 'v4' })],
      new Set(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.liveOnly).toBe(true)
    expect(rows[0]!.live?.tokenId).toBe('9')
  })

  it('does not resurrect a closed mark when live still lists it', () => {
    const closed = [mark({ id: 'c', token_id: '9', protocol: 'v4', status: 'closed' })]
    const rows = mergeClmmOpenPositions(
      [],
      [live({ tokenId: '9', protocol: 'v4' })],
      closedClmmKeys(closed),
    )
    expect(rows).toHaveLength(0)
  })

  it('enriches an open mark from live', () => {
    const rows = mergeClmmOpenPositions(
      [mark({ id: 'm', token_id: '1', protocol: 'v3' })],
      [live({ tokenId: '1', protocol: 'v3', valueUsd: 99 })],
      new Set(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.liveOnly).toBe(false)
    expect(rows[0]!.mark?.id).toBe('m')
    expect(rows[0]!.live?.valueUsd).toBe(99)
  })
})
