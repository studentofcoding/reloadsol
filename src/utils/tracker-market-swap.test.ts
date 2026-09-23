import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionedTransaction } from '@solana/web3.js'
import { AUTO_SLIPPAGE_CAP_BPS } from '@/utils/auto-slippage'

vi.mock('@/utils/swap-executor', () => ({
  fetchSwapQuote: vi.fn(),
  executeClientSwap: vi.fn(),
}))

import { executeClientSwap, fetchSwapQuote } from '@/utils/swap-executor'
import {
  TRACKER_AUTO_PRIORITY_FEE,
  runTrackerMarketSwap,
} from '@/utils/tracker-market-swap'

const fetchQuote = vi.mocked(fetchSwapQuote)
const execute = vi.mocked(executeClientSwap)

const BASE = {
  connection: {} as never,
  userPublicKey: 'Wallet111',
  signTransaction: async (tx: VersionedTransaction) => tx,
  priorityFeeLamports: TRACKER_AUTO_PRIORITY_FEE,
}

describe('runTrackerMarketSwap', () => {
  beforeEach(() => {
    fetchQuote.mockReset()
    execute.mockReset()
    execute.mockResolvedValue({
      signature: 'sig',
      via: 'rpc',
      outAmount: '99',
    })
  })

  it('caps slippage from quote impact the same way on buy and sell', async () => {
    fetchQuote.mockResolvedValue({
      inputMint: 'in',
      outputMint: 'out',
      inAmount: '1',
      outAmount: '2',
      otherAmountThreshold: '1',
      swapMode: 'ExactIn',
      slippageBps: 20,
      priceImpactPct: '1.2',
      routePlan: [],
    })

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
    expect(buy.impactPct).toBe(1.2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0][0].slippageBps).toBe(140)
    expect(execute.mock.calls[1][0].slippageBps).toBe(140)
    expect(execute.mock.calls[0][0].priorityFeeLamports).toEqual(
      TRACKER_AUTO_PRIORITY_FEE,
    )
    expect(execute.mock.calls[1][0].priorityFeeLamports).toEqual(
      TRACKER_AUTO_PRIORITY_FEE,
    )
    expect(fetchQuote.mock.calls[0][3]).toBe(20)
  })

  it('defaults an omitted fee to auto high and clamps a manual tip to 0.003 SOL', async () => {
    fetchQuote.mockResolvedValue({
      inputMint: 'in',
      outputMint: 'out',
      inAmount: '1',
      outAmount: '2',
      otherAmountThreshold: '1',
      swapMode: 'ExactIn',
      slippageBps: 20,
      priceImpactPct: '0.1',
      routePlan: [],
    })

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
    fetchQuote.mockResolvedValue({
      inputMint: 'in',
      outputMint: 'out',
      inAmount: '1',
      outAmount: '2',
      otherAmountThreshold: '1',
      swapMode: 'ExactIn',
      slippageBps: 20,
      priceImpactPct: '9',
      routePlan: [],
    })

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

  it('does not send when the impact gate rejects every quote', async () => {
    fetchQuote.mockResolvedValue(null)
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
