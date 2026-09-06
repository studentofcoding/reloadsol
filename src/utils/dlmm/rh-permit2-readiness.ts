import {
  encodeFunctionData,
  maxUint256,
  type Address,
  type PublicClient,
} from 'viem'
import {
  PERMIT2,
  PERMIT2_MAX_UINT160,
  PERMIT2_MAX_UINT48,
  permit2Abi,
} from '@/utils/dlmm/rh-batch-executor'
import { erc20Abi } from '@/utils/dlmm/rh-univ2'
import type { RhTxCall } from '@/utils/dlmm/rh-send-calls'

export type Permit2ReadinessStatus =
  | 'ready'
  | 'needs-erc20'
  | 'needs-permit2'
  | 'expired'

export type Permit2TokenReadiness = {
  token: Address
  status: Permit2ReadinessStatus
  erc20Allowance: bigint
  permit2Allowance: bigint
  permit2Expiration: number
}

const EXPIRATION_BUFFER_SECONDS = 60

function uniqueTokens(tokens: readonly Address[]): Address[] {
  const seen = new Set<string>()
  return tokens.filter((token) => {
    const key = token.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readinessStatus(
  erc20Allowance: bigint,
  permit2Allowance: bigint,
  permit2Expiration: number,
  nowSeconds: number,
): Permit2ReadinessStatus {
  if (erc20Allowance < maxUint256) return 'needs-erc20'
  if (permit2Expiration <= nowSeconds + EXPIRATION_BUFFER_SECONDS) return 'expired'
  if (permit2Allowance < PERMIT2_MAX_UINT160) return 'needs-permit2'
  return 'ready'
}

/** Pure on-chain reads for one-time Permit2 setup readiness. */
export async function readPermit2Readiness(params: {
  publicClient: PublicClient
  account: Address
  tokens: readonly Address[]
  spender: Address
  nowSeconds?: number
}): Promise<Permit2TokenReadiness[]> {
  const nowSeconds = params.nowSeconds ?? Math.floor(Date.now() / 1000)
  return await Promise.all(
    uniqueTokens(params.tokens).map(async (token) => {
      const [erc20Allowance, permit2State] = await Promise.all([
        params.publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [params.account, PERMIT2],
        }),
        params.publicClient.readContract({
          address: PERMIT2,
          abi: permit2Abi,
          functionName: 'allowance',
          args: [params.account, token, params.spender],
        }),
      ])
      const permit2Allowance = permit2State[0]
      const permit2Expiration = Number(permit2State[1])
      return {
        token,
        status: readinessStatus(
          erc20Allowance,
          permit2Allowance,
          permit2Expiration,
          nowSeconds,
        ),
        erc20Allowance,
        permit2Allowance,
        permit2Expiration,
      }
    }),
  )
}

/** Setup-only calls; never includes a swap or BatchExecutor.executeBatch. */
export function planPermit2SetupCalls(params: {
  readiness: readonly Permit2TokenReadiness[]
  spender: Address
  nowSeconds?: number
}): RhTxCall[] {
  const nowSeconds = params.nowSeconds ?? Math.floor(Date.now() / 1000)
  const calls: RhTxCall[] = []
  const seen = new Set<string>()

  for (const item of params.readiness) {
    const key = item.token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    if (item.erc20Allowance < maxUint256) {
      calls.push({
        to: item.token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PERMIT2, maxUint256],
        }),
      })
    }
    if (
      item.permit2Allowance < PERMIT2_MAX_UINT160 ||
      item.permit2Expiration <= nowSeconds + EXPIRATION_BUFFER_SECONDS
    ) {
      calls.push({
        to: PERMIT2,
        data: encodeFunctionData({
          abi: permit2Abi,
          functionName: 'approve',
          args: [
            item.token,
            params.spender,
            PERMIT2_MAX_UINT160,
            Number(PERMIT2_MAX_UINT48),
          ],
        }),
      })
    }
  }
  return calls
}

export function isPermit2Ready(
  readiness: readonly Permit2TokenReadiness[],
): boolean {
  return readiness.every((item) => item.status === 'ready')
}
