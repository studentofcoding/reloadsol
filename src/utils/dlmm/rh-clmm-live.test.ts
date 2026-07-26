import { describe, expect, it } from 'vitest'
import {
  isRhOwnerAddress,
  liveRowToOnChain,
  markToLiveRow,
} from '@/utils/dlmm/rh-clmm-live-row'
import { rhClmmLiveCacheKey } from '@/utils/dlmm/rh-clmm-live'
import type { RhClmmPosition } from '@/types/dlmm'

describe('rh-clmm-live helpers', () => {
  it('validates owner addresses', () => {
    expect(isRhOwnerAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73')).toBe(
      true,
    )
    expect(isRhOwnerAddress('not-an-address')).toBe(false)
  })

  it('builds redis key lowercased', () => {
    expect(rhClmmLiveCacheKey('0xABC')).toBe('rh-clmm-live:v1:0xabc')
  })

  it('round-trips mark → live → onChain for claim sheet', () => {
    const mark: RhClmmPosition = {
      id: 'm1',
      token_id: '42',
      protocol: 'v3',
      pool_address: '0xpool',
      pair_label: 'WETH/FOO',
      token_address: null,
      deposit_symbol: 'WETH',
      owner_address: '0xowner',
      entry_value_usd: 10,
      current_value_usd: 12,
      pnl_pct: 20,
      status: 'open',
      mint_tx: null,
      close_tx: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      closed_at: null,
      unclaimed_fees_usd: 0.5,
      in_range: true,
      tick_lower: -100,
      tick_upper: 100,
      symbol0: 'WETH',
      symbol1: 'FOO',
      liquidity: '123',
      live_synced_at: '2026-01-01T00:00:00Z',
    }
    const live = markToLiveRow(mark)
    expect(live.tokenId).toBe('42')
    expect(live.unclaimedFeesUsd).toBe(0.5)
    const onChain = liveRowToOnChain(live)
    expect(onChain.tokenId).toBe(BigInt(42))
    expect(onChain.liquidity).toBe(BigInt(123))
    expect(onChain.inRange).toBe(true)
  })
})
