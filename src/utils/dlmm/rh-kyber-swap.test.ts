import { describe, expect, it, vi } from 'vitest'
import {
  buildKyberLegResults,
  executeRhParentKyberBuy,
  executorWalletCalls,
  planKyberLegCalls,
  prepareKyberSwapLegsParallel,
  wethWrapShortfall,
} from '@/utils/dlmm/rh-kyber-swap'
import {
  RhSequentialWriteError,
  executeRhWalletCalls,
  type RhTxCall,
} from '@/utils/dlmm/rh-send-calls'

vi.mock('@/utils/kyber-aggregator', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('@/utils/kyber-aggregator')>()
  return {
    ...orig,
    clientKyberRoute: vi.fn(async () => ({
      routeSummary: { mock: true },
      routerAddress: '0x00000000000000000000000000000000000000b2',
      amountIn: '1000',
    })),
    clientKyberBuild: vi.fn(async (params: { sender: string }) => ({
      data: '0xdeadbeef' as const,
      routerAddress: '0x00000000000000000000000000000000000000b2',
      amountIn: '1000',
      valueWei: BigInt(0),
      sender: params.sender,
    })),
  }
})

// Force the legacy (non-executor, non-permit2) sequential wallet path so a
// reverted receipt deterministically maps to a failed leg.
vi.mock('@/utils/dlmm/rh-batch-executor', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('@/utils/dlmm/rh-batch-executor')>()
  return {
    ...orig,
    getRhBatchExecutorAddress: () => '',
    isRhPermit2SwapsEnabled: () => false,
  }
})

vi.mock('@/utils/dlmm/rh-send-calls', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('@/utils/dlmm/rh-send-calls')>()
  return {
    ...orig,
    executeRhWalletCalls: vi.fn(),
  }
})

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const ROUTER = '0x00000000000000000000000000000000000000b2'
const ACCOUNT = '0x00000000000000000000000000000000000000a1'
const EXECUTOR = '0x00000000000000000000000000000000000000e1'
const TOKEN_IN = '0x0000000000000000000000000000000000000077'
const TOKEN_OUT = '0x0000000000000000000000000000000000000088'

type ReadArgs = { address: string; functionName: string; args: unknown[] }

/** Fake PublicClient driven by a per-(address,functionName) response map. */
function fakePublicClient(
  handler: (call: ReadArgs) => unknown,
): import('viem').PublicClient {
  return {
    readContract: vi.fn(async (call: ReadArgs) => handler(call)),
  } as unknown as import('viem').PublicClient
}

describe('prepareKyberSwapLegsParallel approval planning', () => {
  const legs = [{ tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: '1000' }]

  it('legacy router mode: approves the router when allowance is short', async () => {
    const publicClient = fakePublicClient(() => BigInt(0))
    const [plan] = await prepareKyberSwapLegsParallel({
      publicClient,
      account: ACCOUNT as `0x${string}`,
      legs,
      slippageBps: 100,
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.calls).toHaveLength(2)
    expect(plan.calls[0].to).toBe(TOKEN_IN) // approve(router, maxUint256)
    expect(plan.calls[1].to).toBe(ROUTER) // swap
    expect(plan.swap.amountIn).toBe(BigInt(1000))
  })

  it('permit2 mode: approve(Permit2) + permit2.approve(token, router) when short', async () => {
    const publicClient = fakePublicClient((call) => {
      if (call.functionName === 'allowance' && call.address.toLowerCase() === PERMIT2.toLowerCase()) {
        return [BigInt(0), 0, 0] as const // permit2 allowance (amount, exp, nonce)
      }
      return BigInt(0) // erc20 allowance to Permit2
    })
    const [plan] = await prepareKyberSwapLegsParallel({
      publicClient,
      account: ACCOUNT as `0x${string}`,
      legs,
      slippageBps: 100,
      approval: { mode: 'permit2' },
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.calls).toHaveLength(3)
    expect(plan.calls[0].to).toBe(TOKEN_IN) // approve(PERMIT2, maxUint256)
    expect(plan.calls[1].to).toBe(PERMIT2) // permit2.approve(token, router, …)
    expect(plan.calls[2].to).toBe(ROUTER) // swap
  })

  it('permit2 mode: skips approvals when allowances suffice and unexpired', async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 86_400
    const publicClient = fakePublicClient((call) => {
      if (call.functionName === 'allowance' && call.address.toLowerCase() === PERMIT2.toLowerCase()) {
        return [(BigInt(1) << BigInt(160)) - BigInt(1), farFuture, 0] as const
      }
      return BigInt(1_000_000)
    })
    const [plan] = await prepareKyberSwapLegsParallel({
      publicClient,
      account: ACCOUNT as `0x${string}`,
      legs,
      slippageBps: 100,
      approval: { mode: 'permit2' },
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.calls).toHaveLength(1) // swap only
    expect(plan.calls[0].to).toBe(ROUTER)
  })

  it('executor spender override: permit2.approve targets the executor, build sender is the executor', async () => {
    const { clientKyberBuild } = await import('@/utils/kyber-aggregator')
    let permit2Spender: unknown
    const publicClient = fakePublicClient((call) => {
      if (call.functionName === 'allowance' && call.address.toLowerCase() === PERMIT2.toLowerCase()) {
        permit2Spender = call.args[2]
        return [BigInt(0), 0, 0] as const
      }
      return BigInt(1_000_000) // erc20 allowance to Permit2 already ok
    })
    const [plan] = await prepareKyberSwapLegsParallel({
      publicClient,
      account: ACCOUNT as `0x${string}`,
      legs,
      slippageBps: 100,
      approval: { mode: 'permit2', spender: EXECUTOR as `0x${string}` },
      buildSender: EXECUTOR as `0x${string}`,
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(permit2Spender).toBe(EXECUTOR)
    expect(plan.calls).toHaveLength(2) // permit2.approve + swap (no erc20 approve)
    expect(plan.calls[0].to).toBe(PERMIT2)
    expect(vi.mocked(clientKyberBuild).mock.calls.at(-1)?.[0].sender).toBe(
      EXECUTOR,
    )
  })
})

describe('wethWrapShortfall', () => {
  it('returns 0 when WETH covers need', () => {
    expect(wethWrapShortfall(BigInt(100), BigInt(100))).toBe(BigInt(0))
    expect(wethWrapShortfall(BigInt(50), BigInt(100))).toBe(BigInt(0))
  })

  it('returns shortfall only', () => {
    expect(wethWrapShortfall(BigInt(100), BigInt(40))).toBe(BigInt(60))
    expect(wethWrapShortfall(BigInt(10), BigInt(0))).toBe(BigInt(10))
  })
})

const call = (n: number): RhTxCall =>
  ({ to: `0x${String(n).padStart(40, '0')}`, data: '0x' }) as RhTxCall

describe('executorWalletCalls', () => {
  const batch = call(9)

  it('sends only executeBatch when approvals are already live', () => {
    expect(
      executorWalletCalls(
        [{ calls: [call(1)] }, { calls: [call(2)] }],
        batch,
      ),
    ).toEqual([batch])
  })

  it('dedupes identical Permit2 approvals across legs', () => {
    const approve = call(3)
    const out = executorWalletCalls(
      [
        { calls: [approve, call(1)] },
        { calls: [approve, call(2)] },
      ],
      batch,
    )
    expect(out).toEqual([approve, batch])
  })
})

describe('planKyberLegCalls', () => {
  it('maps flat call indices to legs and tracks per-leg hashes', () => {
    const plan = planKyberLegCalls(
      [call(0)], // wrap
      [{ calls: [call(1), call(2)] }, { calls: [call(3)] }],
    )
    expect(plan.flatCalls).toHaveLength(4)
    expect(plan.legEndCallIndex).toEqual([2, 3])
    expect(plan.callLeg).toEqual([-1, 0, 0, 1])

    plan.onProgress(1, '0xaaa')
    expect(plan.legHashes[0]).toBeUndefined() // approve call, not leg end
    plan.onProgress(2, '0xbbb')
    plan.onProgress(3, '0xccc')
    expect(plan.legHashes).toEqual(['0xbbb', '0xccc'])
  })
})

describe('buildKyberLegResults', () => {
  const legs = [
    { tokenAddress: '0xaaa', symbol: 'AAA' },
    { tokenAddress: '0xbbb', symbol: 'BBB' },
  ]
  const legEndCallIndex = [2, 3]

  it('marks every leg confirmed with per-leg hashes on batch success', () => {
    const results = buildKyberLegResults({
      legs,
      legEndCallIndex,
      legHashes: ['0xh0', undefined],
      failedCallIndex: null,
      batchHash: '0xbatch',
    })
    expect(results[0]).toMatchObject({ success: true, hash: '0xh0' })
    expect(results[1]).toMatchObject({ success: true, hash: '0xbatch' })
  })

  it('keeps confirmed legs successful when a later call fails sequentially', () => {
    const results = buildKyberLegResults({
      legs,
      legEndCallIndex,
      legHashes: ['0xh0', undefined],
      failedCallIndex: 3,
      error: 'tx reverted',
    })
    expect(results[0]).toMatchObject({ success: true, hash: '0xh0' })
    expect(results[1]).toMatchObject({ success: false, error: 'tx reverted' })
  })

  it('fails the leg whose own call index failed', () => {
    const results = buildKyberLegResults({
      legs,
      legEndCallIndex,
      legHashes: [undefined, undefined],
      failedCallIndex: 2,
      error: 'tx reverted',
    })
    expect(results.every((r) => !r.success)).toBe(true)
  })
})

describe('executeRhParentKyberBuy — reverted receipt gating', () => {
  it('marks the leg failed when the sequential write reverts on-chain', async () => {
    // Deterministic kyber mock: native ETH → no approvals, single swap call.
    vi.mocked(executeRhWalletCalls).mockRejectedValue(
      new RhSequentialWriteError('Transaction reverted: 0xdead', 0, '0xdead'),
    )

    const publicClient = {
      readContract: vi.fn(),
      getBalance: vi.fn(async () => BigInt(1) << BigInt(200)),
    } as unknown as import('viem').PublicClient
    const walletClient = {} as unknown as import('viem').WalletClient

    const result = await executeRhParentKyberBuy({
      publicClient,
      walletClient,
      account: ACCOUNT as `0x${string}`,
      amountHuman: 0.5,
      tokenMints: [{ tokenAddress: TOKEN_OUT }],
      slippageBps: 200,
      quote: 'ETH',
    })

    expect(result.success).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      tokenAddress: TOKEN_OUT,
      success: false,
    })
    expect(result.results[0].error).toContain('reverted')
    expect(executeRhWalletCalls).toHaveBeenCalledTimes(1)
  })
})
