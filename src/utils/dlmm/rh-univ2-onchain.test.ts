import { describe, expect, it } from 'vitest'
import { RH_USDG, RH_WETH } from './rh-univ2'
import {
  mergeUniv2DbAndOnchain,
  univ2ShareToPosition,
} from './rh-univ2-onchain'
import type { RhUniv2Position } from '@/types/dlmm'

describe('univ2ShareToPosition', () => {
  it('maps a non-zero LP share to a DAMM row', () => {
    const row = univ2ShareToPosition({
      owner: '0xABCDEF0000000000000000000000000000000001',
      pairId: '0x1111111111111111111111111111111111111111',
      token0: RH_USDG,
      token1: '0x2222222222222222222222222222222222222222',
      symbol0: 'USDG',
      symbol1: 'PEPE',
      lpBalance: 1n,
    })
    expect(row).not.toBeNull()
    expect(row!.id).toBe('onchain:0x1111111111111111111111111111111111111111')
    expect(row!.quote_symbol).toBe('USDG')
    expect(row!.token_address).toBe('0x2222222222222222222222222222222222222222')
    expect(row!.pair_label).toBe('USDG/PEPE')
    expect(row!.status).toBe('open')
  })

  it('returns null for zero balance or no quote token', () => {
    expect(
      univ2ShareToPosition({
        owner: '0x1',
        pairId: RH_WETH,
        token0: RH_USDG,
        token1: RH_WETH,
        lpBalance: 0n,
      }),
    ).toBeNull()
    expect(
      univ2ShareToPosition({
        owner: '0x1',
        pairId: '0x3333333333333333333333333333333333333333',
        token0: '0x4444444444444444444444444444444444444444',
        token1: '0x5555555555555555555555555555555555555555',
        lpBalance: 1n,
      }),
    ).toBeNull()
  })
})

describe('mergeUniv2DbAndOnchain', () => {
  it('keeps DB rows and adds on-chain pools not already open', () => {
    const db: RhUniv2Position[] = [
      {
        id: 'db-1',
        pool_address: '0xaaaaaa0000000000000000000000000000000001',
        pair_label: 'A/USDG',
        token_address: '0x1',
        quote_symbol: 'USDG',
        owner_address: '0xowner',
        lp_token_address: '0xaaaaaa0000000000000000000000000000000001',
        entry_quote_amount: 1,
        entry_value_usd: 1,
        current_value_usd: 1,
        pnl_pct: 0,
        status: 'open',
        add_tx: null,
        remove_tx: null,
        created_at: '',
        updated_at: '',
        closed_at: null,
      },
    ]
    const onchain = [
      univ2ShareToPosition({
        owner: '0xowner',
        pairId: '0xaaaaaa0000000000000000000000000000000001',
        token0: RH_USDG,
        token1: '0x1',
        lpBalance: 1n,
      })!,
      univ2ShareToPosition({
        owner: '0xowner',
        pairId: '0xbbbbbb0000000000000000000000000000000002',
        token0: RH_WETH,
        token1: '0x2',
        lpBalance: 1n,
      })!,
    ]
    const merged = mergeUniv2DbAndOnchain(db, onchain)
    expect(merged).toHaveLength(2)
    expect(merged[0]!.id).toBe('db-1')
    expect(merged[1]!.id).toContain('onchain:')
  })
})
