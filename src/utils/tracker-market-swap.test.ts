import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionedTransaction } from '@solana/web3.js'
import { AUTO_SLIPPAGE_CAP_BPS } from '@/utils/auto-slippage'

vi.mock('@/utils/swap-executor', () => ({
  prepareSwapTransaction: vi.fn(),
  peekFreshPreparedSwap: vi.fn(() => null),
  putPreparedSwapCache: vi.fn(),
  executeClientSwap: vi.fn(),
}))

import {
  executeClientSwap,
  peekFreshPreparedSwap,
  prepareSwapTransaction,
} from '@/utils/swap-executor'
import {
  TRACKER_AUTO_PRIORITY_FEE,
  runTrackerMarketSwap,
} from '@/utils/tracker-market-swap'

const prepare = vi.mocked(prepareSwapTransaction)
const peek = vi.mocked(peekFreshPreparedSwap)
const execute = vi.mocked(executeClientSwap)

const BASE = {
  connection: {} as never,
  userPublicKey: 'Wallet111',
  signTransaction: async (tx: VersionedTransaction) => tx,
  priorityFeeLamports: TRACKER_AUTO_PRIORITY_FEE,
}

const prepared = {
  provider: 'jupiter_swap' as const,
  swapTransaction: 'AQID',
  outAmount: '2',
  requestId: 'req-1',
  priceImpact: 0.012,
}

describe('runTrackerMarketSwap', () => {
  beforeEach(() => {
    prepare.mockReset()
    peek.mockReset()
    execute.mockReset()
    peek.mockReturnValue(null)
    prepare.mockResolvedValue(prepared)
    execute.mockResolvedValue({
      signature: 'sig',
      via: 'jupiter',
      outAmount: '99',
    })
  })

  it('caps slippage from the prepared order the same way on buy and sell', async () => {
    const buy = await runTrackerMarketSwap({
      ...BASE,
      inputMint: 'SOL',
      outputMint: 'TOKEN',
      amount: 100_000_000,
    })
    const sell = await runTrackerMarketSwap({
      ...BASE,
      inputMint: 'TOKEN',
      outputMint: 'USDC',
      amount: 500,
    })

    expect(buy.slippageBps).toBe(140)
    expect(sell.slippageBps).toBe(buy.slippageBps)
    expect(buy.impactPct).toBeCloseTo(1.2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0][0].slippageBps).toBe(140)
    expect(execute.mock.calls[1][0].slippageBps).toBe(140)
    expect(prepare.mock.calls[0][0].slippageBps).toBe(20)
    expect(prepare.mock.calls[1][0].slippageBps).toBe(140)
    expect(execute.mock.calls[0][0].priorityFeeLamports).toEqual(
      TRACKER_AUTO_PRIORITY_FEE,
    )
    expect(execute.mock.calls[1][0].priorityFeeLamports).toEqual(
      TRACKER_AUTO_PRIORITY_FEE,
    )
  })

  it('reuses the seed order when auto slippage stays at the floor', async () => {
    prepare.mockResolvedValue({ ...prepared, priceImpact: 0 })
    const result = await runTrackerMarketSwap({
      ...BASE,
      inputMint: 'SOL',
      outputMint: 'TOKEN',
      amount: 1_000,
    })
    expect(result.slippageBps).toBe(20)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('defaults an omitted fee to auto high and clamps a manual tip to 0.003 SOL', async () => {
    await runTrackerMarketSwap({
      connection: BASE.connection,
      userPublicKey: BASE.userPublicKey,
      signTransaction: BASE.signTransaction,
      inputMint: 'SOL',
      outputMint: 'TOKEN',
      amount: 1_000,
    })
    await runTrackerMarketSwap({
      ...BASE,
      inputMint: 'SOL',
      outputMint: 'TOKEN',
      amount: 1_000,
      priorityFeeLamports: 9_000_000,
    })

    expect(execute.mock.calls[0][0].priorityFeeLamports).toEqual(
      TRACKER_AUTO_PRIORITY_FEE,
    )
    expect(execute.mock.calls[1][0].priorityFeeLamports).toBe(3_000_000)
  })

  it('caps auto slippage at 8% and still sends', async () => {
    prepare.mockResolvedValue({ ...prepared, priceImpact: 9 })
    const result = await runTrackerMarketSwap({
      ...BASE,
      inputMint: 'USDC',
      outputMint: 'TOKEN',
      amount: 10_000_000,
    })
    expect(result.volatile).toBe(true)
    expect(result.slippageBps).toBe(AUTO_SLIPPAGE_CAP_BPS)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not send when the impact gate rejects the order', async () => {
    prepare.mockResolvedValue({ ...prepared, priceImpact: 50 })
    await expect(
      runTrackerMarketSwap({
        ...BASE,
        inputMint: 'SOL',
        outputMint: 'TOKEN',
        amount: 1,
      }),
    ).rejects.toThrow(/price impact/)
    expect(execute).not.toHaveBeenCalled()
  })
})
