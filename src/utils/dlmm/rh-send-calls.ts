/**
 * EIP-5792 wallet_sendCalls with sequential sendTransaction fallback.
 * msg.sender stays the user (unlike Multicall3).
 */

import { decodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient } from 'viem'
import { getCapabilities, sendCalls, waitForCallsStatus } from 'viem/actions'
import { RH_CHAIN_ID } from '@/utils/dlmm/rh-univ2'
import { isWalletUserRejection } from '@/utils/wallet-rejection'

// ---------------------------------------------------------------------------
// Session infinite-approval memo. Once an infinite ERC20 approve (or a max
// Permit2 allowance) CONFIRMS, remember owner|token|spender for this page
// session so later runs never re-prompt/re-sign the same approval — even when
// the on-chain allowance read races behind the just-mined approval.
// ---------------------------------------------------------------------------

const MAX_UINT256 = (1n << 256n) - 1n
const MAX_UINT160 = (1n << 160n) - 1n
const ERC20_APPROVE_SIG = '0x095ea7b3'
const infiniteApprovals = new Set<string>()

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const PERMIT2_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const

/** True when this page session already confirmed an infinite approval. */
export function isRhInfiniteApprovalLive(
  owner: string,
  token: string,
  spender: string,
): boolean {
  return infiniteApprovals.has(
    `${owner.toLowerCase()}|${token.toLowerCase()}|${spender.toLowerCase()}`,
  )
}

/** After a confirmed tx, remember any infinite approval it carried. */
function recordConfirmedApprovals(account: Address, calls: RhTxCall[]): void {
  const owner = account.toLowerCase()
  for (const call of calls) {
    try {
      if (call.data.toLowerCase().startsWith(ERC20_APPROVE_SIG)) {
        const decoded = decodeFunctionData({
          abi: ERC20_APPROVE_ABI,
          data: call.data,
        })
        const [spender, amount] = decoded.args as [Address, bigint]
        if (amount === MAX_UINT256) {
          infiniteApprovals.add(
            `${owner}|${call.to.toLowerCase()}|${spender.toLowerCase()}`,
          )
        }
        continue
      }
    } catch {
      // not an ERC20 approve
    }
    try {
      const decoded = decodeFunctionData({
        abi: PERMIT2_APPROVE_ABI,
        data: call.data,
      })
      const args = decoded.args as readonly [
        Address,
        Address,
        bigint,
        number,
      ]
      const [token, spender, amount] = args
      if (amount >= MAX_UINT160) {
        infiniteApprovals.add(
          `${owner}|${token.toLowerCase()}|${spender.toLowerCase()}`,
        )
      }
    } catch {
      // not a Permit2 approve
    }
  }
}

export type RhTxCall = {
  to: Address
  data: Hex
  value?: bigint
  gas?: bigint
}

/** Fired after each call is confirmed in sequential mode (not batched mode). */
export type RhCallProgress = (callIndex: number, hash: Hex) => void

/** Sequential write failed at a specific call index; earlier calls confirmed. */
export class RhSequentialWriteError extends Error {
  readonly callIndex: number
  readonly lastHash?: Hex
  constructor(message: string, callIndex: number, lastHash?: Hex) {
    super(message)
    this.name = 'RhSequentialWriteError'
    this.callIndex = callIndex
    this.lastHash = lastHash
  }
}

export function shouldFallbackFromSendCalls(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (isWalletUserRejection(err)) {
    return false
  }
  return (
    msg.includes('wallet_sendcalls') ||
    msg.includes('sendcalls') ||
    msg.includes('method not found') ||
    msg.includes('method not supported') ||
    msg.includes('does not exist') ||
    msg.includes('not supported') ||
    msg.includes('unsupported') ||
    msg.includes('capability') ||
    msg.includes('atomic') ||
    msg.includes('4200')
  )
}

/** True when wallet advertises atomic batch for the active chain (EIP-5792). */
export async function rhWalletSupportsAtomicBatch(params: {
  walletClient: WalletClient
  account: Address
}): Promise<boolean> {
  const { walletClient, account } = params
  try {
    const caps = await getCapabilities(walletClient, { account })
    const chainId = walletClient.chain?.id ?? RH_CHAIN_ID
    const hexKey = `0x${chainId.toString(16)}`
    const byChain = caps as Record<
      string,
      { atomic?: { status?: string } } | undefined
    >
    const status =
      byChain[hexKey]?.atomic?.status ??
      byChain[hexKey.toLowerCase()]?.atomic?.status ??
      byChain[String(chainId)]?.atomic?.status
    return status === 'supported' || status === 'ready'
  } catch {
    return false
  }
}

async function writeCallsSequential(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  calls: RhTxCall[]
  onProgress?: RhCallProgress
}): Promise<{ hash: Hex }> {
  const { publicClient, walletClient, account, calls, onProgress } = params
  let lastHash: Hex | undefined
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    try {
      lastHash = await walletClient.sendTransaction({
        account,
        chain: walletClient.chain,
        to: call.to,
        data: call.data,
        value: call.value ?? BigInt(0),
        ...(call.gas != null ? { gas: call.gas } : {}),
      })
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: lastHash,
      })
      // A mined-but-reverted tx still resolves here; never report it confirmed.
      if (receipt.status !== 'success') {
        throw new RhSequentialWriteError(
          `Transaction reverted: ${lastHash}`,
          i,
          lastHash,
        )
      }
      onProgress?.(i, lastHash)
      recordConfirmedApprovals(account, [call])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new RhSequentialWriteError(msg, i, lastHash)
    }
  }
  if (!lastHash) throw new Error('No calls to send')
  return { hash: lastHash }
}

/**
 * 1 call → sequential write.
 * 2+ → try wallet_sendCalls only if atomic capability present; else sequential.
 * `hash` is the last real tx hash when receipts exist (not the batch id).
 */
export async function executeRhWalletCalls(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  calls: RhTxCall[]
  onProgress?: RhCallProgress
}): Promise<{ hash: Hex; batched: boolean }> {
  const { publicClient, walletClient, account, calls } = params
  if (calls.length === 0) throw new Error('No calls to send')
  if (calls.length === 1) {
    const { hash } = await writeCallsSequential(params)
    return { hash, batched: false }
  }

  const canBatch = await rhWalletSupportsAtomicBatch({ walletClient, account })
  if (!canBatch) {
    console.warn(
      '[rh-send-calls] wallet lacks atomic batch on this chain — sequential Approve/Swap signs',
    )
    const { hash } = await writeCallsSequential(params)
    return { hash, batched: false }
  }

  try {
    const { id } = await sendCalls(walletClient, {
      account,
      chain: walletClient.chain,
      calls: calls.map((c) => ({
        to: c.to,
        data: c.data,
        value: c.value ?? BigInt(0),
        ...(c.gas != null ? { gas: c.gas } : {}),
      })),
    })
    const status = await waitForCallsStatus(walletClient, { id })
    if (status.status !== 'success') {
      throw new Error(`Batch status: ${status.status ?? 'unknown'}`)
    }
    const receipts = status.receipts ?? []
    // A reverted receipt inside the batch must not be counted as confirmed.
    // Only an explicit non-success status is treated as a failure — an absent
    // status (older wallets) is left to the overall waitForCallsStatus verdict.
    if (receipts.some((r) => r.status != null && r.status !== 'success')) {
      throw new Error('sendCalls batch contained a reverted transaction')
    }
    recordConfirmedApprovals(account, calls)
    const txHashes = receipts
      .map((r) => r.transactionHash)
      .filter((h): h is Hex => typeof h === 'string' && h.startsWith('0x'))
    if (txHashes.length === 0) {
      throw new Error('sendCalls succeeded but returned no tx receipts')
    }
    const hash = txHashes[txHashes.length - 1]
    if (!hash) {
      throw new Error('sendCalls succeeded but returned no tx receipts')
    }
    return { hash, batched: true }
  } catch (error) {
    if (!shouldFallbackFromSendCalls(error)) throw error
    console.warn(
      '[rh-send-calls] sendCalls failed — sequential fallback',
      error instanceof Error ? error.message : error,
    )
    const { hash } = await writeCallsSequential({
      publicClient,
      walletClient,
      account,
      calls,
      onProgress: params.onProgress,
    })
    return { hash, batched: false }
  }
}

/**
 * Applies approval calls one by one, never aborting on a single failure, and
 * never counting a reverted receipt as confirmed.
 */
async function writeApprovalsSequential(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  calls: RhTxCall[]
}): Promise<RhApprovalResult> {
  const { publicClient, walletClient, account, calls } = params
  let confirmed = 0
  const failures: RhApprovalFailure[] = []
  for (const call of calls) {
    try {
      const hash = await walletClient.sendTransaction({
        account,
        chain: walletClient.chain,
        to: call.to,
        data: call.data,
        value: call.value ?? BigInt(0),
        ...(call.gas != null ? { gas: call.gas } : {}),
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        failures.push({ call, error: `Transaction reverted: ${hash}` })
        continue
      }
      confirmed += 1
      recordConfirmedApprovals(account, [call])
    } catch (error) {
      failures.push({
        call,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { confirmed, failures }
}

export type RhApprovalFailure = { call: RhTxCall; error: string }
export type RhApprovalResult = {
  confirmed: number
  failures: RhApprovalFailure[]
}

/**
 * Setup-only approvals writer. Safe to retry: an approval is idempotent, so a
 * failed atomic batch always falls back to sequential — and one failing call
 * (e.g. a single hostile token) never blocks the remaining approvals.
 */
export async function executeRhApprovalCalls(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  calls: RhTxCall[]
}): Promise<RhApprovalResult> {
  const { publicClient, walletClient, account, calls } = params
  if (calls.length === 0) return { confirmed: 0, failures: [] }
  if (calls.length === 1) {
    return await writeApprovalsSequential({
      publicClient,
      walletClient,
      account,
      calls,
    })
  }

  const canBatch = await rhWalletSupportsAtomicBatch({ walletClient, account })
  if (canBatch) {
    try {
      const { id } = await sendCalls(walletClient, {
        account,
        chain: walletClient.chain,
        calls: calls.map((c) => ({
          to: c.to,
          data: c.data,
          value: c.value ?? BigInt(0),
          ...(c.gas != null ? { gas: c.gas } : {}),
        })),
      })
      const status = await waitForCallsStatus(walletClient, { id })
      const receipts = status.receipts ?? []
      const reverted = receipts.some(
        (r) => r.status != null && r.status !== 'success',
      )
      if (status.status === 'success' && !reverted) {
        recordConfirmedApprovals(account, calls)
        return { confirmed: calls.length, failures: [] }
      }
      // Anything short of a fully-successful batch falls through to the
      // idempotent sequential path below.
    } catch (error) {
      // A user rejection is a deliberate cancel — never re-prompt for it.
      if (isWalletUserRejection(error)) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          confirmed: 0,
          failures: calls.map((call) => ({ call, error: message })),
        }
      }
    }
  }

  return await writeApprovalsSequential({
    publicClient,
    walletClient,
    account,
    calls,
  })
}
