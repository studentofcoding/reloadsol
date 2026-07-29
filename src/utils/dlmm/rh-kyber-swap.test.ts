import { describe, expect, it } from 'vitest'
import {
  buildKyberLegResults,
  planKyberLegCalls,
  wethWrapShortfall,
} from '@/utils/dlmm/rh-kyber-swap'
import type { RhTxCall } from '@/utils/dlmm/rh-send-calls'

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
