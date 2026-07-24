import { describe, expect, it } from 'vitest'
import { encodeFunctionData, maxUint256, type Address } from 'viem'
import {
  RH_V2_ROUTER,
  RH_WETH,
  erc20Abi,
  univ2RouterAbi,
  wethAbi,
} from '@/utils/dlmm/rh-univ2'
import {
  buildRhUniv2RemoveCalls,
  buildRhUniv2ZapAddCalls,
} from '@/utils/dlmm/rh-univ2-lp'

const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address
const QUOTE = '0x3333333333333333333333333333333333333333' as Address
const BASE = '0x4444444444444444444444444444444444444444' as Address
const LP = '0x5555555555555555555555555555555555555555' as Address
const DEADLINE = BigInt(1_700_000_000)

describe('buildRhUniv2ZapAddCalls', () => {
  it('includes wrap + approve + swap + base approve + add when cold', () => {
    const calls = buildRhUniv2ZapAddCalls({
      account: ACCOUNT,
      quoteAddress: QUOTE,
      baseAddress: BASE,
      quoteAmount: BigInt(100),
      wrapEthAmount: BigInt(50),
      swapAmount: BigInt(50),
      remainAmount: BigInt(50),
      expectedBase: BigInt(40),
      minSwapOut: BigInt(39),
      amountAMin: BigInt(49),
      amountBMin: BigInt(39),
      quoteAllowance: BigInt(0),
      baseAllowance: BigInt(0),
      deadlineTs: DEADLINE,
    })
    expect(calls[0]!.to).toBe(RH_WETH)
    expect(calls[0]!.data).toBe(
      encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
    )
    expect(calls[0]!.value).toBe(BigInt(50))
    expect(calls.some((c) => c.to === QUOTE)).toBe(true)
    expect(calls.some((c) => c.to === BASE)).toBe(true)
    expect(calls[calls.length - 1]!.to).toBe(RH_V2_ROUTER)
    expect(calls[calls.length - 1]!.data).toBe(
      encodeFunctionData({
        abi: univ2RouterAbi,
        functionName: 'addLiquidity',
        args: [
          QUOTE,
          BASE,
          BigInt(50),
          BigInt(40),
          BigInt(49),
          BigInt(39),
          ACCOUNT,
          DEADLINE,
        ],
      }),
    )
  })

  it('skips wrap and approves when already funded and allowed', () => {
    const calls = buildRhUniv2ZapAddCalls({
      account: ACCOUNT,
      quoteAddress: QUOTE,
      baseAddress: BASE,
      quoteAmount: BigInt(100),
      wrapEthAmount: BigInt(0),
      swapAmount: BigInt(50),
      remainAmount: BigInt(50),
      expectedBase: BigInt(40),
      minSwapOut: BigInt(39),
      amountAMin: BigInt(49),
      amountBMin: BigInt(39),
      quoteAllowance: maxUint256,
      baseAllowance: maxUint256,
      deadlineTs: DEADLINE,
    })
    expect(calls).toHaveLength(2) // swap + add
    expect(calls[0]!.data).toBe(
      encodeFunctionData({
        abi: univ2RouterAbi,
        functionName: 'swapExactTokensForTokens',
        args: [
          BigInt(50),
          BigInt(39),
          [QUOTE, BASE],
          ACCOUNT,
          DEADLINE,
        ],
      }),
    )
  })
})

describe('buildRhUniv2RemoveCalls', () => {
  it('approve + remove when allowance low', () => {
    const calls = buildRhUniv2RemoveCalls({
      account: ACCOUNT,
      lp: LP,
      token0: QUOTE,
      token1: BASE,
      lpBal: BigInt(10),
      lpAllowance: BigInt(0),
      deadlineTs: DEADLINE,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.data).toBe(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [RH_V2_ROUTER, maxUint256],
      }),
    )
  })

  it('remove-only when allowance enough', () => {
    const calls = buildRhUniv2RemoveCalls({
      account: ACCOUNT,
      lp: LP,
      token0: QUOTE,
      token1: BASE,
      lpBal: BigInt(10),
      lpAllowance: BigInt(10),
      deadlineTs: DEADLINE,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toBe(RH_V2_ROUTER)
  })
})
