import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import { getCapabilities, sendCalls, waitForCallsStatus } from 'viem/actions'
import {
  executeRhApprovalCalls,
  type RhTxCall,
} from '@/utils/dlmm/rh-send-calls'

vi.mock('viem/actions', () => ({
  getCapabilities: vi.fn(),
  sendCalls: vi.fn(),
  waitForCallsStatus: vi.fn(),
}))

const ACCOUNT = '0x00000000000000000000000000000000000000a1' as Address
const TOKEN_A = '0x0000000000000000000000000000000000000011' as Address
const TOKEN_B = '0x0000000000000000000000000000000000000022' as Address

const CALL_A: RhTxCall = { to: TOKEN_A, data: '0xdeadbeef' }
const CALL_B: RhTxCall = { to: TOKEN_B, data: '0xdeadbeef' }

/** Wallet whose atomic-batch capability is advertised for RH chain 4663. */
function atomicCapability(): never {
  return { '0x1237': { atomic: { status: 'supported' } } } as never
}

function walletClient(hashes: Hex[] = []): {
  client: WalletClient
  sendTransaction: ReturnType<typeof vi.fn>
} {
  const sendTransaction = vi.fn()
  for (const hash of hashes) sendTransaction.mockResolvedValueOnce(hash)
  return {
    client: { sendTransaction } as unknown as WalletClient,
    sendTransaction,
  }
}

function publicClient(statuses: Array<'success' | 'reverted'>): PublicClient {
  const waitForTransactionReceipt = vi.fn()
  for (const status of statuses) {
    waitForTransactionReceipt.mockResolvedValueOnce({ status })
  }
  return { waitForTransactionReceipt } as unknown as PublicClient
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('executeRhApprovalCalls', () => {
  it('confirms every approval when the atomic batch succeeds', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(atomicCapability())
    vi.mocked(sendCalls).mockResolvedValue({ id: '0xbatch' } as never)
    vi.mocked(waitForCallsStatus).mockResolvedValue({
      status: 'success',
      receipts: [{ status: 'success', transactionHash: '0x1' }],
    } as never)
    const { client, sendTransaction } = walletClient()

    const result = await executeRhApprovalCalls({
      publicClient: publicClient([]),
      walletClient: client,
      account: ACCOUNT,
      calls: [CALL_A, CALL_B],
    })

    expect(result).toEqual({ confirmed: 2, failures: [] })
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('falls back to sequential when the batch fails for an unrecognized reason', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(atomicCapability())
    // Not one of shouldFallbackFromSendCalls' keywords — approvals must still land.
    vi.mocked(sendCalls).mockRejectedValue(new Error('429 rate limited'))
    const { client, sendTransaction } = walletClient(['0xaa', '0xbb'])

    const result = await executeRhApprovalCalls({
      publicClient: publicClient(['success', 'success']),
      walletClient: client,
      account: ACCOUNT,
      calls: [CALL_A, CALL_B],
    })

    expect(result).toEqual({ confirmed: 2, failures: [] })
    expect(sendTransaction).toHaveBeenCalledTimes(2)
  })

  it('reports a reverted approval and still sends the remaining calls', async () => {
    vi.mocked(getCapabilities).mockRejectedValue(new Error('no capabilities'))
    const { client, sendTransaction } = walletClient(['0xaa', '0xbb'])

    const result = await executeRhApprovalCalls({
      publicClient: publicClient(['reverted', 'success']),
      walletClient: client,
      account: ACCOUNT,
      calls: [CALL_A, CALL_B],
    })

    expect(result.confirmed).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].call.to).toBe(TOKEN_A)
    expect(result.failures[0].error).toContain('reverted')
    expect(sendTransaction).toHaveBeenCalledTimes(2)
  })

  it('does not re-prompt sequentially after a user rejection', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(atomicCapability())
    vi.mocked(sendCalls).mockRejectedValue(
      Object.assign(new Error('User rejected the request'), {
        name: 'UserRejectedRequestError',
      }),
    )
    const { client, sendTransaction } = walletClient()

    const result = await executeRhApprovalCalls({
      publicClient: publicClient([]),
      walletClient: client,
      account: ACCOUNT,
      calls: [CALL_A, CALL_B],
    })

    expect(result.confirmed).toBe(0)
    expect(result.failures).toHaveLength(2)
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})
