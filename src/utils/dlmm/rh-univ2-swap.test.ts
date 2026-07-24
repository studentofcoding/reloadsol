import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Address } from 'viem'
import {
  RH_V2_ROUTER,
  RH_WETH,
  erc20Abi,
  univ2RouterAbi,
} from '@/utils/dlmm/rh-univ2'
import { buildRhUniv2SellCalls } from '@/utils/dlmm/rh-univ2-swap'

const TOKEN = '0x1111111111111111111111111111111111111111' as Address
const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address
const DEADLINE = BigInt(1_700_000_000)
const AMOUNT_IN = BigInt(1_000_000)
const MIN_OUT = BigInt(900)

describe('buildRhUniv2SellCalls', () => {
  it('includes approve + swap when allowance is below amountIn', () => {
    const calls = buildRhUniv2SellCalls({
      token: TOKEN,
      account: ACCOUNT,
      amountIn: AMOUNT_IN,
      minOut: MIN_OUT,
      allowance: AMOUNT_IN - BigInt(1),
      deadlineTs: DEADLINE,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.to).toBe(TOKEN)
    expect(calls[0]!.data).toBe(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [RH_V2_ROUTER, AMOUNT_IN],
      }),
    )
    expect(calls[1]!.to).toBe(RH_V2_ROUTER)
    expect(calls[1]!.data).toBe(
      encodeFunctionData({
        abi: univ2RouterAbi,
        functionName: 'swapExactTokensForETH',
        args: [AMOUNT_IN, MIN_OUT, [TOKEN, RH_WETH], ACCOUNT, DEADLINE],
      }),
    )
  })

  it('is swap-only when allowance covers amountIn', () => {
    const calls = buildRhUniv2SellCalls({
      token: TOKEN,
      account: ACCOUNT,
      amountIn: AMOUNT_IN,
      minOut: MIN_OUT,
      allowance: AMOUNT_IN,
      deadlineTs: DEADLINE,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.to).toBe(RH_V2_ROUTER)
    expect(calls[0]!.data).toBe(
      encodeFunctionData({
        abi: univ2RouterAbi,
        functionName: 'swapExactTokensForETH',
        args: [AMOUNT_IN, MIN_OUT, [TOKEN, RH_WETH], ACCOUNT, DEADLINE],
      }),
    )
  })
})
