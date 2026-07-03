import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Connection } from '@solana/web3.js'
import { RaptorAPIError } from '@/utils/solanatracker-raptor'

vi.mock('@/utils/rpc-rate-limit', () => ({
  waitForRpcRateLimit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/utils/solanatracker-raptor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/solanatracker-raptor')>()
  return {
    ...actual,
    getRaptorTransactionStatusSafe: vi.fn(),
  }
})

import { getRaptorTransactionStatusSafe } from '@/utils/solanatracker-raptor'
import {
  confirmSwapSignature,
  confirmSwapSignaturesBatch,
  waitForSwapConfirmation,
} from '@/utils/swap-executor'

const SIG = 'test-signature-base58'

type StatusEntry = { confirmationStatus?: string; err?: unknown } | null

/** Each getSignatureStatuses call consumes the next response (entries per sig, or an Error to throw). */
function mockConnection(rpcResponses: Array<StatusEntry[] | Error>) {
  let call = 0
  return {
    getSignatureStatuses: vi.fn(async (sigs: string[]) => {
      const entry = rpcResponses[Math.min(call, rpcResponses.length - 1)]
      call += 1
      if (entry instanceof Error) throw entry
      return { value: sigs.map((_, i) => entry[i] ?? null) }
    }),
    confirmTransaction: vi.fn(),
  } as unknown as Connection
}

describe('waitForSwapConfirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resolves via RPC while Raptor stays pending (no 90s Raptor-only wait)', async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue({ status: 'pending' })
    const connection = mockConnection([[null], [{ confirmationStatus: 'confirmed' }]])

    const start = Date.now()
    await waitForSwapConfirmation({
      signature: SIG,
      via: 'raptor',
      connection,
      direct: true,
      maxAttempts: 5,
      intervalMs: 10,
    })
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500)
    expect(getRaptorTransactionStatusSafe).toHaveBeenCalled()
    expect(connection.getSignatureStatuses).toHaveBeenCalledTimes(2)
    expect(connection.confirmTransaction).not.toHaveBeenCalled()
  })

  it('resolves via Raptor without touching RPC when Raptor confirms first', async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue({ status: 'confirmed' })
    const connection = mockConnection([[null]])

    await waitForSwapConfirmation({
      signature: SIG,
      via: 'raptor',
      connection,
      direct: true,
      maxAttempts: 3,
      intervalMs: 10,
    })

    expect(connection.getSignatureStatuses).not.toHaveBeenCalled()
  })

  it('succeeds when Raptor returns 404 and RPC confirms on retry', async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue(null)
    const connection = mockConnection([[null], [{ confirmationStatus: 'confirmed' }]])

    await waitForSwapConfirmation({
      signature: SIG,
      via: 'raptor',
      connection,
      direct: true,
      maxAttempts: 5,
      intervalMs: 10,
    })

    // Raptor dropped permanently after the 404-style null
    expect(getRaptorTransactionStatusSafe).toHaveBeenCalledTimes(1)
  })

  it('counts processed as landed', async () => {
    const connection = mockConnection([[{ confirmationStatus: 'processed' }]])

    await waitForSwapConfirmation({
      signature: SIG,
      via: 'rpc',
      connection,
      maxAttempts: 3,
      intervalMs: 10,
    })

    expect(connection.getSignatureStatuses).toHaveBeenCalledTimes(1)
  })

  it('throws when Raptor reports failed', async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue({ status: 'failed' })
    const connection = mockConnection([[null]])

    await expect(
      waitForSwapConfirmation({
        signature: SIG,
        via: 'raptor',
        connection,
        direct: true,
        maxAttempts: 2,
        intervalMs: 10,
      }),
    ).rejects.toBeInstanceOf(RaptorAPIError)
  })

  it('throws on-chain error from RPC status', async () => {
    const connection = mockConnection([[{ err: { InstructionError: [0, 'Custom'] } }]])

    await expect(
      waitForSwapConfirmation({
        signature: SIG,
        via: 'rpc',
        connection,
        maxAttempts: 3,
        intervalMs: 10,
      }),
    ).rejects.toThrow('failed on-chain')
  })

  it('fails fast after repeated RPC errors instead of spinning to timeout', async () => {
    const connection = mockConnection([new Error('proxy 429')])

    await expect(
      waitForSwapConfirmation({
        signature: SIG,
        via: 'rpc',
        connection,
        maxAttempts: 40,
        intervalMs: 10,
      }),
    ).rejects.toThrow('RPC confirmation unavailable')

    expect(connection.getSignatureStatuses).toHaveBeenCalledTimes(3)
  })

  it('via rpc skips Raptor status calls', async () => {
    const connection = mockConnection([[{ confirmationStatus: 'confirmed' }]])

    await waitForSwapConfirmation({
      signature: SIG,
      via: 'rpc',
      connection,
      maxAttempts: 3,
      intervalMs: 10,
    })

    expect(getRaptorTransactionStatusSafe).not.toHaveBeenCalled()
  })

  it('times out when nothing confirms', async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue({ status: 'pending' })
    const connection = mockConnection([[null]])

    await expect(
      waitForSwapConfirmation({
        signature: SIG,
        via: 'raptor',
        connection,
        direct: true,
        maxAttempts: 2,
        intervalMs: 10,
      }),
    ).rejects.toThrow('confirmation timeout')
  })
})

describe('confirmSwapSignaturesBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checks 3 signatures with ONE batched RPC call per tick', async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue({ status: 'pending' })
    const connection = mockConnection([
      [
        { confirmationStatus: 'confirmed' },
        { confirmationStatus: 'confirmed' },
        { confirmationStatus: 'confirmed' },
      ],
    ])

    const items = ['sig-a', 'sig-b', 'sig-c'].map((signature) => ({
      signature,
      via: 'raptor' as const,
      direct: true,
    }))

    const results = await confirmSwapSignaturesBatch(items, connection, {
      intervalMs: 10,
      deadlineMs: 100,
    })

    expect(connection.getSignatureStatuses).toHaveBeenCalledTimes(1)
    expect(vi.mocked(connection.getSignatureStatuses).mock.calls[0][0]).toEqual([
      'sig-a',
      'sig-b',
      'sig-c',
    ])
    expect(results.get('sig-a')).toBeNull()
    expect(results.get('sig-b')).toBeNull()
    expect(results.get('sig-c')).toBeNull()
  })

  it('mixes Raptor-confirmed and RPC-confirmed results', async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockImplementation(async (sig) =>
      sig === 'sig-a' ? { status: 'confirmed' } : { status: 'pending' },
    )
    const connection = mockConnection([[{ confirmationStatus: 'confirmed' }]])

    const results = await confirmSwapSignaturesBatch(
      [
        { signature: 'sig-a', via: 'raptor', direct: true },
        { signature: 'sig-b', via: 'raptor', direct: true },
      ],
      connection,
      { intervalMs: 10, deadlineMs: 100 },
    )

    expect(results.get('sig-a')).toBeNull()
    expect(results.get('sig-b')).toBeNull()
    // sig-a already confirmed via Raptor — only sig-b hits RPC
    expect(vi.mocked(connection.getSignatureStatuses).mock.calls[0][0]).toEqual(['sig-b'])
  })

  it('records per-sig errors without failing the whole batch', async () => {
    const connection = mockConnection([
      [{ err: { InstructionError: [0, 'Custom'] } }, { confirmationStatus: 'finalized' }],
    ])

    const results = await confirmSwapSignaturesBatch(
      [
        { signature: 'sig-bad', via: 'rpc' },
        { signature: 'sig-ok', via: 'rpc' },
      ],
      connection,
      { intervalMs: 10, deadlineMs: 100 },
    )

    expect(results.get('sig-bad')).toContain('failed on-chain')
    expect(results.get('sig-ok')).toBeNull()
  })
})

describe('confirmSwapSignature', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to hybrid batch confirm', async () => {
    vi.mocked(getRaptorTransactionStatusSafe).mockResolvedValue({ status: 'confirmed' })
    const connection = mockConnection([[null]])

    await confirmSwapSignature({
      signature: SIG,
      via: 'raptor',
      connection,
      direct: true,
    })

    expect(getRaptorTransactionStatusSafe).toHaveBeenCalled()
    expect(connection.confirmTransaction).not.toHaveBeenCalled()
  })
})
