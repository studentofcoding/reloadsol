import { decodeFunctionData } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PERMIT2,
  RH_NATIVE_FEE_TOKEN,
  RH_WETH,
  batchExecutorAbi,
  computePullAmounts,
  encodeExecuteBatch,
  encodePullAndApproveRouter,
  getRhBatchExecutorAddress,
  isRhPermit2SwapsEnabled,
  planExecutorBatch,
  platformFeeAmount,
  type ExecutorSwapLeg,
} from '@/utils/dlmm/rh-batch-executor'

const EXECUTOR = '0x00000000000000000000000000000000000000e1'
const ACCOUNT = '0x00000000000000000000000000000000000000a1'
const ROUTER = '0x00000000000000000000000000000000000000b2'
const TOKEN = '0x0000000000000000000000000000000000000077'

afterEach(() => {
  delete process.env.NEXT_PUBLIC_RH_BATCH_EXECUTOR_ADDRESS
  delete process.env.RH_BATCH_EXECUTOR_ADDRESS
  delete process.env.NEXT_PUBLIC_RH_PERMIT2_SWAPS
  delete process.env.RH_PERMIT2_SWAPS
})

describe('env flags', () => {
  it('executor address is null when unset or invalid', () => {
    expect(getRhBatchExecutorAddress()).toBeNull()
    process.env.RH_BATCH_EXECUTOR_ADDRESS = 'not-an-address'
    expect(getRhBatchExecutorAddress()).toBeNull()
  })

  it('accepts a checksummed/lower address from either env var', () => {
    process.env.RH_BATCH_EXECUTOR_ADDRESS = EXECUTOR
    expect(getRhBatchExecutorAddress()).toBe(EXECUTOR)
    delete process.env.RH_BATCH_EXECUTOR_ADDRESS
    process.env.NEXT_PUBLIC_RH_BATCH_EXECUTOR_ADDRESS = EXECUTOR
    expect(getRhBatchExecutorAddress()).toBe(EXECUTOR)
  })

  it('prefers the statically accessed public executor address', () => {
    const publicExecutor = '0x61F1eb4cF3a7962d54413769369675be6BEa3907'
    process.env.NEXT_PUBLIC_RH_BATCH_EXECUTOR_ADDRESS = publicExecutor
    process.env.RH_BATCH_EXECUTOR_ADDRESS = EXECUTOR
    expect(getRhBatchExecutorAddress()).toBe(publicExecutor)
  })

  it('permit2 swaps default OFF when env absent, ON with =1, OFF with =0', () => {
    expect(isRhPermit2SwapsEnabled()).toBe(false)
    process.env.RH_PERMIT2_SWAPS = '1'
    expect(isRhPermit2SwapsEnabled()).toBe(true)
    process.env.RH_PERMIT2_SWAPS = '0'
    expect(isRhPermit2SwapsEnabled()).toBe(false)
    process.env.NEXT_PUBLIC_RH_PERMIT2_SWAPS = 'true'
    expect(isRhPermit2SwapsEnabled()).toBe(true)
  })

  it('prefers the statically accessed public Permit2 flag', () => {
    process.env.NEXT_PUBLIC_RH_PERMIT2_SWAPS = '0'
    process.env.RH_PERMIT2_SWAPS = '1'
    expect(isRhPermit2SwapsEnabled()).toBe(false)
  })
})

describe('computePullAmounts', () => {
  it('pulls from wallet balance first, wrap covers the rest', () => {
    expect(computePullAmounts([BigInt(100), BigInt(100)], BigInt(150))).toEqual([
      BigInt(100),
      BigInt(50),
    ])
  })

  it('returns zeros when balance is zero (fully wrapped)', () => {
    expect(computePullAmounts([BigInt(10), BigInt(20)], BigInt(0))).toEqual([
      BigInt(0),
      BigInt(0),
    ])
  })

  it('pulls full amounts when balance covers everything', () => {
    expect(computePullAmounts([BigInt(5), BigInt(5)], BigInt(1_000))).toEqual([
      BigInt(5),
      BigInt(5),
    ])
  })
})

describe('planExecutorBatch + encoding', () => {
  const erc20Leg: ExecutorSwapLeg = {
    nativeIn: false,
    tokenIn: TOKEN as `0x${string}`,
    router: ROUTER as `0x${string}`,
    pullAmount: BigInt(40),
    approveAmount: BigInt(100),
    swapData: '0xdeadbeef',
    swapValueWei: BigInt(0),
  }

  it('encodes wrap + pullAndApprove + swap + dust sweep for a WETH buy', () => {
    const { batch, txValue } = planExecutorBatch({
      executor: EXECUTOR as `0x${string}`,
      account: ACCOUNT as `0x${string}`,
      wethWrapWei: BigInt(60),
      legs: [erc20Leg],
    })
    // wrap, pull+approve, swap, sweep
    expect(batch).toHaveLength(4)
    expect(txValue).toBe(BigInt(60))

    expect(batch[0].target).toBe(RH_WETH)
    expect(batch[0].value).toBe(BigInt(60))
    expect(batch[0].allowFailure).toBe(false)

    expect(batch[1].target).toBe(EXECUTOR)
    const pull = decodeFunctionData({
      abi: batchExecutorAbi,
      data: batch[1].data,
    })
    expect(pull.functionName).toBe('pullAndApproveRouter')
    expect(pull.args[0]).toBe(TOKEN)
    expect(pull.args[1]).toBe(ROUTER)
    expect(pull.args[2]).toBe(BigInt(40)) // pullAmount
    expect(pull.args[3]).toBe(BigInt(100)) // approveAmount

    expect(batch[2].target).toBe(ROUTER)
    expect(batch[2].data).toBe('0xdeadbeef')

    expect(batch[3].target).toBe(EXECUTOR)
    expect(batch[3].allowFailure).toBe(true) // dust sweep is non-critical
  })

  it('omits wrap and sweep when no WETH shortfall', () => {
    const { batch, txValue } = planExecutorBatch({
      executor: EXECUTOR as `0x${string}`,
      account: ACCOUNT as `0x${string}`,
      wethWrapWei: BigInt(0),
      legs: [erc20Leg],
    })
    expect(batch).toHaveLength(2)
    expect(txValue).toBe(BigInt(0))
  })

  it('records ERC20 pull notionals for the 25 bps fee', () => {
    const { feeTokens, tradeAmounts } = planExecutorBatch({
      executor: EXECUTOR as `0x${string}`,
      account: ACCOUNT as `0x${string}`,
      wethWrapWei: BigInt(0),
      legs: [
        {
          ...erc20Leg,
          pullAmount: BigInt(10_000),
          approveAmount: BigInt(10_000),
        },
      ],
    })
    expect(feeTokens[0]?.toLowerCase()).toBe(TOKEN.toLowerCase())
    expect(tradeAmounts[0]).toBe(BigInt(10_000))
  })

  it('uses feeNotional when the Kyber size is already net of the fee', () => {
    const { tradeAmounts } = planExecutorBatch({
      executor: EXECUTOR as `0x${string}`,
      account: ACCOUNT as `0x${string}`,
      wethWrapWei: BigInt(0),
      legs: [
        {
          ...erc20Leg,
          pullAmount: BigInt(9_975),
          approveAmount: BigInt(9_975),
          feeNotional: BigInt(10_000),
        },
      ],
    })
    expect(tradeAmounts[0]).toBe(BigInt(10_000))
  })

  it('routes native-in legs straight to the router with value', () => {
    const nativeLeg: ExecutorSwapLeg = {
      nativeIn: true,
      router: ROUTER as `0x${string}`,
      pullAmount: BigInt(0),
      approveAmount: BigInt(0),
      swapData: '0xcafe',
      swapValueWei: BigInt(7),
    }
    const { batch, txValue } = planExecutorBatch({
      executor: EXECUTOR as `0x${string}`,
      account: ACCOUNT as `0x${string}`,
      wethWrapWei: BigInt(0),
      legs: [nativeLeg],
    })
    expect(batch).toHaveLength(1)
    expect(batch[0].target).toBe(ROUTER)
    expect(batch[0].value).toBe(BigInt(7))
    expect(txValue).toBe(BigInt(7))
  })

  it('adds 25 bps extra ETH when the batch spends native value', () => {
    const nativeLeg: ExecutorSwapLeg = {
      nativeIn: true,
      router: ROUTER as `0x${string}`,
      pullAmount: BigInt(0),
      approveAmount: BigInt(0),
      swapData: '0xcafe',
      swapValueWei: BigInt(10_000),
    }
    const { txValue, feeTokens, tradeAmounts } = planExecutorBatch({
      executor: EXECUTOR as `0x${string}`,
      account: ACCOUNT as `0x${string}`,
      wethWrapWei: BigInt(0),
      legs: [nativeLeg],
    })
    expect(tradeAmounts).toEqual([BigInt(10_000)])
    expect(feeTokens[0]).toBe(RH_NATIVE_FEE_TOKEN)
    expect(txValue).toBe(BigInt(10_000) + platformFeeAmount(BigInt(10_000)))
  })

  it('encodeExecuteBatch round-trips through the ABI', () => {
    const { batch, feeTokens, tradeAmounts } = planExecutorBatch({
      executor: EXECUTOR as `0x${string}`,
      account: ACCOUNT as `0x${string}`,
      wethWrapWei: BigInt(1),
      legs: [erc20Leg],
    })
    const encoded = encodeExecuteBatch(batch, feeTokens, tradeAmounts)
    const decoded = decodeFunctionData({ abi: batchExecutorAbi, data: encoded })
    expect(decoded.functionName).toBe('executeBatch')
    const calls = decoded.args[0] as unknown as Array<{
      target: string
      value: bigint
    }>
    expect(calls).toHaveLength(batch.length)
    expect(calls[0].target.toLowerCase()).toBe(RH_WETH.toLowerCase())
    expect(calls[0].value).toBe(BigInt(1))
    expect(decoded.args[1]).toEqual(feeTokens)
    expect(decoded.args[2]).toEqual(tradeAmounts)
  })

  it('encodePullAndApproveRouter uses the Permit2 max expiration by default', () => {
    const data = encodePullAndApproveRouter({
      token: TOKEN as `0x${string}`,
      router: ROUTER as `0x${string}`,
      pullAmount: BigInt(1),
      approveAmount: BigInt(2),
    })
    const decoded = decodeFunctionData({ abi: batchExecutorAbi, data })
    expect(decoded.functionName).toBe('pullAndApproveRouter')
    // uint48 max (viem decodes uint48 as number)
    expect(decoded.args[4]).toBe(Number((BigInt(1) << BigInt(48)) - BigInt(1)))
  })

  it('exposes the canonical Permit2 address', () => {
    expect(PERMIT2).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
  })
})
