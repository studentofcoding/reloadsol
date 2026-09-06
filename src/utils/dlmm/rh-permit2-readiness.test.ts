import {
  decodeFunctionData,
  maxUint256,
  type Address,
  type PublicClient,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  PERMIT2,
  PERMIT2_MAX_UINT160,
  PERMIT2_MAX_UINT48,
  permit2Abi,
} from '@/utils/dlmm/rh-batch-executor'
import { erc20Abi } from '@/utils/dlmm/rh-univ2'
import {
  planPermit2SetupCalls,
  readPermit2Readiness,
  type Permit2TokenReadiness,
} from '@/utils/dlmm/rh-permit2-readiness'

const ACCOUNT = '0x00000000000000000000000000000000000000a1' as Address
const SPENDER = '0x00000000000000000000000000000000000000e1' as Address
const TOKEN_A = '0x0000000000000000000000000000000000000011' as Address
const TOKEN_B = '0x0000000000000000000000000000000000000022' as Address
const NOW = 1_800_000_000

function clientWithReads(values: unknown[]): {
  client: PublicClient
  readContract: ReturnType<typeof vi.fn>
} {
  const readContract = vi.fn()
  for (const value of values) readContract.mockResolvedValueOnce(value)
  return {
    client: { readContract } as unknown as PublicClient,
    readContract,
  }
}

describe('readPermit2Readiness', () => {
  it('reads ERC20 and Permit2 allowances and reports ready', async () => {
    const { client, readContract } = clientWithReads([
      maxUint256,
      [PERMIT2_MAX_UINT160, NOW + 10_000, 0],
    ])
    const result = await readPermit2Readiness({
      publicClient: client,
      account: ACCOUNT,
      tokens: [TOKEN_A, TOKEN_A],
      spender: SPENDER,
      nowSeconds: NOW,
    })

    expect(result).toEqual([
      {
        token: TOKEN_A,
        status: 'ready',
        erc20Allowance: maxUint256,
        permit2Allowance: PERMIT2_MAX_UINT160,
        permit2Expiration: NOW + 10_000,
      },
    ])
    expect(readContract).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      erc20: BigInt(0),
      permit2: PERMIT2_MAX_UINT160,
      expiration: NOW + 10_000,
      status: 'needs-erc20',
    },
    {
      erc20: maxUint256,
      permit2: BigInt(1),
      expiration: NOW + 10_000,
      status: 'needs-permit2',
    },
    {
      erc20: maxUint256,
      permit2: PERMIT2_MAX_UINT160,
      expiration: NOW,
      status: 'expired',
    },
  ] as const)('reports $status', async (testCase) => {
    const { client } = clientWithReads([
      testCase.erc20,
      [testCase.permit2, testCase.expiration, 0],
    ])
    const [result] = await readPermit2Readiness({
      publicClient: client,
      account: ACCOUNT,
      tokens: [TOKEN_A],
      spender: SPENDER,
      nowSeconds: NOW,
    })
    expect(result.status).toBe(testCase.status)
  })
})

describe('planPermit2SetupCalls', () => {
  const row = (
    token: Address,
    values: Partial<Permit2TokenReadiness> = {},
  ): Permit2TokenReadiness => ({
    token,
    status: 'ready',
    erc20Allowance: maxUint256,
    permit2Allowance: PERMIT2_MAX_UINT160,
    permit2Expiration: NOW + 10_000,
    ...values,
  })

  it('returns no approval prefix when allowances are live', () => {
    expect(
      planPermit2SetupCalls({
        readiness: [row(TOKEN_A)],
        spender: SPENDER,
        nowSeconds: NOW,
      }),
    ).toEqual([])
  })

  it('plans max ERC20 and Permit2 approvals and deduplicates tokens', () => {
    const calls = planPermit2SetupCalls({
      readiness: [
        row(TOKEN_A, {
          status: 'needs-erc20',
          erc20Allowance: BigInt(0),
          permit2Allowance: BigInt(0),
        }),
        row(TOKEN_A, {
          status: 'needs-erc20',
          erc20Allowance: BigInt(0),
          permit2Allowance: BigInt(0),
        }),
        row(TOKEN_B),
      ],
      spender: SPENDER,
      nowSeconds: NOW,
    })
    expect(calls).toHaveLength(2)

    const erc20Approval = decodeFunctionData({
      abi: erc20Abi,
      data: calls[0].data,
    })
    expect(calls[0].to).toBe(TOKEN_A)
    expect(erc20Approval.functionName).toBe('approve')
    expect(erc20Approval.args).toEqual([PERMIT2, maxUint256])

    const permit2Approval = decodeFunctionData({
      abi: permit2Abi,
      data: calls[1].data,
    })
    expect(calls[1].to).toBe(PERMIT2)
    expect(permit2Approval.functionName).toBe('approve')
    expect(permit2Approval.args).toEqual([
      TOKEN_A,
      SPENDER,
      PERMIT2_MAX_UINT160,
      Number(PERMIT2_MAX_UINT48),
    ])
  })

  it('renews an expired Permit2 approval without reapproving ERC20', () => {
    const calls = planPermit2SetupCalls({
      readiness: [
        row(TOKEN_A, {
          status: 'expired',
          permit2Expiration: NOW,
        }),
      ],
      spender: SPENDER,
      nowSeconds: NOW,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].to).toBe(PERMIT2)
  })
})
