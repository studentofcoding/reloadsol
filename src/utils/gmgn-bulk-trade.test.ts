import { describe, expect, it } from 'vitest'
import {
  GMGN_NATIVE_ETH,
  GMGN_RH_USDG,
  GMGN_SOL_NATIVE,
  gmgnNativeToken,
  gmgnTokenDecimals,
  slippageBpsToGmgnPercent,
  toGmgnRawAmount,
} from './gmgn-currencies'
import {
  buildGmgnBuyQuoteRequest,
  executeGmgnBulkBuy,
} from './gmgn-bulk-trade'
import { buildRhUniv2SellCalls } from './dlmm/rh-univ2-swap'
import { RH_USDG, RH_V2_ROUTER, RH_WETH } from './dlmm/rh-univ2'
import type { Address } from 'viem'

describe('gmgn currencies', () => {
  it('resolves native currency addresses', () => {
    expect(gmgnNativeToken('sol')).toBe(GMGN_SOL_NATIVE)
    expect(gmgnNativeToken('robinhood')).toBe(GMGN_NATIVE_ETH)
  })

  it('converts bps to GMGN percent', () => {
    expect(slippageBpsToGmgnPercent(100)).toBe(1)
    expect(slippageBpsToGmgnPercent(200)).toBe(2)
    expect(slippageBpsToGmgnPercent(500)).toBe(5)
  })

  it('builds raw amounts in smallest units', () => {
    expect(toGmgnRawAmount(0.1, 9)).toBe('100000000')
    expect(toGmgnRawAmount(0.01, 18)).toBe('10000000000000000')
  })
})

describe('buildGmgnBuyQuoteRequest', () => {
  it('shapes robinhood quote against native ETH', () => {
    const req = buildGmgnBuyQuoteRequest({
      chain: 'robinhood',
      from: '0xabc',
      tokenAddress: '0x1111111111111111111111111111111111111111',
      amountHuman: 0.01,
      slippageBps: 200,
    })
    expect(req.inputToken).toBe(GMGN_NATIVE_ETH)
    expect(req.amount).toBe('10000000000000000')
    expect(req.slippage).toBe(2)
    expect(req.outputToken).toBe('0x1111111111111111111111111111111111111111')
  })

  it('shapes robinhood USDG buy with 6 decimals', () => {
    expect(gmgnTokenDecimals('robinhood', GMGN_RH_USDG)).toBe(6)
    const req = buildGmgnBuyQuoteRequest({
      chain: 'robinhood',
      from: '0xabc',
      tokenAddress: '0x1111111111111111111111111111111111111111',
      amountHuman: 10,
      slippageBps: 100,
      inputToken: GMGN_RH_USDG,
    })
    expect(req.inputToken).toBe(GMGN_RH_USDG)
    expect(req.amount).toBe('10000000')
  })
})

describe('buildRhUniv2SellCalls', () => {
  const token = '0x2222222222222222222222222222222222222222' as Address
  const account = '0x3333333333333333333333333333333333333333' as Address

  it('encodes token→ETH sell', () => {
    const calls = buildRhUniv2SellCalls({
      token,
      account,
      amountIn: BigInt(1),
      minOut: BigInt(1),
      allowance: BigInt(1),
      deadlineTs: BigInt(1),
      quote: 'ETH',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toBe(RH_V2_ROUTER)
    // path encodes WETH in calldata — spot-check router target + non-empty data
    expect(calls[0]!.data.startsWith('0x')).toBe(true)
    expect(RH_WETH).toMatch(/^0x/)
  })

  it('encodes token→USDG sell via swapExactTokensForTokens', () => {
    const calls = buildRhUniv2SellCalls({
      token,
      account,
      amountIn: BigInt(1),
      minOut: BigInt(1),
      allowance: BigInt(0),
      deadlineTs: BigInt(1),
      quote: 'USDG',
    })
    // approve + swap
    expect(calls).toHaveLength(2)
    expect(calls[0]!.to).toBe(token)
    expect(calls[1]!.to).toBe(RH_V2_ROUTER)
    expect(RH_USDG.toLowerCase()).toBe(GMGN_RH_USDG.toLowerCase())
  })
})

describe('executeGmgnBulkBuy', () => {
  it('runs sequential quote-swap without live spend when fns injected', async () => {
    const calls: string[] = []
    const { results, success } = await executeGmgnBulkBuy({
      chain: 'sol',
      from: 'BoundSol1111111111111111111111111111111',
      amountHuman: 0.1,
      tokenMints: [
        { tokenAddress: 'TokenA111111111111111111111111111111111', symbol: 'A' },
        { tokenAddress: 'TokenB111111111111111111111111111111111', symbol: 'B' },
      ],
      slippageBps: 100,
      quoteFn: async () => {
        calls.push('quote')
        return { output_amount: '1' }
      },
      swapFn: async () => {
        calls.push('swap')
        return { order_id: 'ord', status: 'confirmed', hash: 'h' }
      },
      orderFn: async () => {
        calls.push('order')
        return { status: 'confirmed' }
      },
    })
    expect(success).toBe(true)
    expect(results).toHaveLength(2)
    expect(calls.filter((c) => c === 'quote')).toHaveLength(2)
    expect(calls.filter((c) => c === 'swap')).toHaveLength(2)
    // confirmed immediately — no poll
    expect(calls.filter((c) => c === 'order')).toHaveLength(0)
  })
})
