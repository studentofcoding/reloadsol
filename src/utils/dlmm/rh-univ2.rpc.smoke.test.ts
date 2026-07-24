import { describe, expect, it } from 'vitest'
import { createPublicClient, http, parseUnits } from 'viem'
import {
  RH_CHAIN,
  RH_USDG,
  RH_V2_ROUTER,
  RH_WETH,
  getRhRpcUrl,
  univ2RouterAbi,
} from '@/utils/dlmm/rh-univ2'

/** Live RPC smoke — skips offline. */
describe('RH UniV2 ArrowRPC smoke', () => {
  it('getAmountsOut WETH→USDG via router', async () => {
    const client = createPublicClient({
      chain: RH_CHAIN,
      transport: http(getRhRpcUrl()),
    })
    const out = await client.readContract({
      address: RH_V2_ROUTER,
      abi: univ2RouterAbi,
      functionName: 'getAmountsOut',
      args: [parseUnits('0.01', 18), [RH_WETH, RH_USDG]],
    })
    expect(out.length).toBe(2)
    expect(out[1]! > BigInt(0)).toBe(true)
  }, 20_000)
})
