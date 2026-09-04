import { describe, expect, it } from 'vitest'
import type { PrepareSwapParams, PreparedSwap } from '@/utils/swap-executor'
import {
  SWAP_PREPARE_TTL_MS,
  peekFreshPreparedSwap,
  putPreparedSwapCache,
  takeFreshPreparedSwap,
} from '@/utils/swap-executor'

const params = {
  userPublicKey: 'User111111111111111111111111111111111111111',
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'Mint111111111111111111111111111111111111111',
  amount: 1_000_000,
  slippageBps: 100,
} satisfies PrepareSwapParams

const prepared = {
  provider: 'raptor',
  swapTransaction: 'AQID',
  outAmount: '42',
} satisfies PreparedSwap

describe('prepared swap prefetch cache', () => {
  it('peek stays until take consumes, then miss', () => {
    putPreparedSwapCache(params, prepared, 1_000)
    expect(peekFreshPreparedSwap(params, 1_000)?.outAmount).toBe('42')
    expect(takeFreshPreparedSwap(params, 1_000)?.outAmount).toBe('42')
    expect(takeFreshPreparedSwap(params, 1_001)).toBeNull()
  })

  it('expires after TTL', () => {
    putPreparedSwapCache(params, prepared, 1_000)
    expect(
      peekFreshPreparedSwap(params, 1_000 + SWAP_PREPARE_TTL_MS + 1),
    ).toBeNull()
  })
})
