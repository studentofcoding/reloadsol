/**
 * REL-6 / REL-7 — BatchExecutor integration for the RH Kyber swap path.
 *
 * Browser-safe (env flags follow the rh-whitelist.ts pattern:
 * NEXT_PUBLIC_* first, server-only fallback second).
 *
 * Modes (see rh-kyber-swap.ts):
 *  - Executor mode: RH_BATCH_EXECUTOR_ADDRESS set → the whole batch
 *    (wrap + Permit2 pulls + N swaps) is ONE `executeBatch` transaction,
 *    so the wallet signs once regardless of EIP-5792 support.
 *  - Permit2 mode: RH_PERMIT2_SWAPS=1 → per-leg approve(router, maxUint256)
 *    is replaced by one-time ERC20 approve to canonical Permit2 + per-spender
 *    permit2.approve(token, spender, …) (mirrors the v4 mint path, v4.ts).
 *  - Legacy (default when env vars are absent): unchanged production behavior.
 */

import { encodeFunctionData, type Address, type Hex } from 'viem'
import { PERMIT2 } from '@/utils/dlmm/rh-clmm/config'
import { permit2Abi } from '@/utils/dlmm/rh-clmm/abis'
import { weth9Abi } from '@/utils/dlmm/rh-clmm/wrap'
import { RH_WETH } from '@/utils/dlmm/rh-univ2'

// ── Env flags ────────────────────────────────────────────────────────

/**
 * Read public/server env for RH BatchExecutor flags.
 *
 * IMPORTANT: Next.js only inlines `NEXT_PUBLIC_*` into the client bundle when
 * accessed as a *static* property (`process.env.NEXT_PUBLIC_FOO`). Dynamic
 * `process.env[name]` is always undefined in the browser — which made the UI
 * report "BatchExecutor is unavailable" even when .env was set correctly.
 */
function readEnv(...staticValues: Array<string | undefined>): string | undefined {
  for (const v of staticValues) {
    if (v != null && v !== '') return v
  }
  return undefined
}

/** Deployed BatchExecutor on 4663, or null when not configured (= disabled). */
export function getRhBatchExecutorAddress(): Address | null {
  const raw = readEnv(
    process.env.NEXT_PUBLIC_RH_BATCH_EXECUTOR_ADDRESS,
    process.env.RH_BATCH_EXECUTOR_ADDRESS,
  )
  if (!raw) return null
  const trimmed = raw.trim()
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? (trimmed as Address) : null
}

/**
 * Permit2 swap approvals (REL-7). Default OFF so production behavior is
 * unchanged when env vars are absent; set RH_PERMIT2_SWAPS=1 to enable,
 * =0 to force the legacy approve(router, maxUint256) path.
 * (Executor mode implies Permit2 for the executor spender regardless.)
 */
export function isRhPermit2SwapsEnabled(): boolean {
  const raw = readEnv(
    process.env.NEXT_PUBLIC_RH_PERMIT2_SWAPS,
    process.env.RH_PERMIT2_SWAPS,
  )
  if (raw == null) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

// ── ABI (mirrors contracts/src/BatchExecutor.sol) ────────────────────

export const batchExecutorAbi = [
  {
    type: 'function',
    name: 'executeBatch',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          { name: 'allowFailure', type: 'bool' },
        ],
      },
      { name: 'feeTokens', type: 'address[]' },
      { name: 'tradeAmounts', type: 'uint256[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'pullAndApproveRouter',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'router', type: 'address' },
      { name: 'pullAmount', type: 'uint160' },
      { name: 'approveAmount', type: 'uint256' },
      { name: 'permit2Expiration', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sweepToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
] as const

// ── Encoding helpers (pure) ──────────────────────────────────────────

export type RhExecutorCall = {
  target: Address
  value: bigint
  data: Hex
  allowFailure: boolean
}

/** Permit2 uint160 / uint48 maxima (matches v4.ts planPermit2Calls). */
export const PERMIT2_MAX_UINT160 = (BigInt(1) << BigInt(160)) - BigInt(1)
export const PERMIT2_MAX_UINT48 = (BigInt(1) << BigInt(48)) - BigInt(1)

export const RH_PLATFORM_FEE_BPS = 25
export const RH_PLATFORM_FEE_TO =
  '0x795b5c0c89fC5D3b0De6c04141C3F1b6C340603D' as Address
export const RH_NATIVE_FEE_TOKEN =
  '0x0000000000000000000000000000000000000000' as Address
export const RH_PLATFORM_FEE_LABEL = '0.25% platform fee'

export function platformFeeAmount(tradeAmount: bigint): bigint {
  return (tradeAmount * BigInt(RH_PLATFORM_FEE_BPS)) / BigInt(10_000)
}

/** Gross wallet debit so Permit2 allowance covers floor(25 bps) plus 1-wei rounding. */
export function platformFeeCover(amount: bigint): bigint {
  return (
    amount +
    (amount * BigInt(RH_PLATFORM_FEE_BPS) + BigInt(9_999)) / BigInt(10_000)
  )
}

export function encodeExecuteBatch(
  calls: RhExecutorCall[],
  feeTokens: Address[] = [],
  tradeAmounts: bigint[] = [],
): Hex {
  return encodeFunctionData({
    abi: batchExecutorAbi,
    functionName: 'executeBatch',
    args: [calls, feeTokens, tradeAmounts],
  })
}

export function encodePullAndApproveRouter(params: {
  token: Address
  router: Address
  pullAmount: bigint
  approveAmount: bigint
  permit2Expiration?: number
}): Hex {
  return encodeFunctionData({
    abi: batchExecutorAbi,
    functionName: 'pullAndApproveRouter',
    args: [
      params.token,
      params.router,
      params.pullAmount,
      params.approveAmount,
      params.permit2Expiration ?? Number(PERMIT2_MAX_UINT48),
    ],
  })
}

export function encodeSweepToken(token: Address, to: Address): Hex {
  return encodeFunctionData({
    abi: batchExecutorAbi,
    functionName: 'sweepToken',
    args: [token, to],
  })
}

/** Re-exported Permit2 planning constants for rh-kyber-swap.ts. */
export { PERMIT2, permit2Abi, weth9Abi, RH_WETH }

/**
 * Greedy pull allocation for the executor batch: the wallet pulls from its
 * own ERC20 balance first; the remaining aggregate shortfall is what the
 * executor wraps from native ETH inside the batch.
 *
 * Returns per-leg pull amounts (same order). Sum(amounts) − sum(pulls)
 * equals min(totalNeed, shortfall) and must match the wrapped amount.
 */
export function computePullAmounts(
  amounts: bigint[],
  walletBalance: bigint,
): bigint[] {
  let remaining = walletBalance
  return amounts.map((a) => {
    if (a <= BigInt(0) || remaining <= BigInt(0)) return BigInt(0)
    const pull = a < remaining ? a : remaining
    remaining -= pull
    return pull
  })
}

export type ExecutorSwapLeg = {
  /** True when the leg pays native ETH directly (Kyber native in). */
  nativeIn: boolean
  /** ERC20 token in (ignored when nativeIn). */
  tokenIn?: Address
  router: Address
  /** Amount to pull from the wallet via Permit2 (0 = fully covered by wrap). */
  pullAmount: bigint
  /** Total amount the router will spend (pull + wrapped portion). */
  approveAmount: bigint
  swapData: Hex
  /** Native value the swap consumes (nativeIn legs). */
  swapValueWei: bigint
  /** 25 bps notional; defaults to pullAmount for ERC20. Sells pass the pre-fee size. */
  feeNotional?: bigint
}

/**
 * Build the full executeBatch call list + tx value for one atomic buy/sell:
 * [wrap?] → per leg [pullAndApproveRouter? → swap] → [sweep WETH dust?].
 * Leftover native ETH is auto-swept back to the batch caller.
 */
export function planExecutorBatch(params: {
  executor: Address
  account: Address
  /** Native ETH to wrap into WETH inside the batch (aggregate shortfall). */
  wethWrapWei: bigint
  legs: ExecutorSwapLeg[]
}): {
  batch: RhExecutorCall[]
  txValue: bigint
  feeTokens: Address[]
  tradeAmounts: bigint[]
} {
  const batch: RhExecutorCall[] = []
  let txValue = BigInt(0)

  if (params.wethWrapWei > BigInt(0)) {
    batch.push({
      target: RH_WETH,
      value: params.wethWrapWei,
      data: encodeFunctionData({ abi: weth9Abi, functionName: 'deposit' }),
      allowFailure: false,
    })
    txValue += params.wethWrapWei
  }

  let hasWrapped = params.wethWrapWei > BigInt(0)
  for (const leg of params.legs) {
    if (leg.nativeIn) {
      batch.push({
        target: leg.router,
        value: leg.swapValueWei,
        data: leg.swapData,
        allowFailure: false,
      })
      txValue += leg.swapValueWei
      continue
    }
    if (!leg.tokenIn) throw new Error('Executor leg missing tokenIn')
    batch.push({
      target: params.executor,
      value: BigInt(0),
      data: encodePullAndApproveRouter({
        token: leg.tokenIn,
        router: leg.router,
        pullAmount: leg.pullAmount,
        approveAmount: leg.approveAmount,
      }),
      allowFailure: false,
    })
    batch.push({
      target: leg.router,
      value: BigInt(0),
      data: leg.swapData,
      allowFailure: false,
    })
  }

  // Sweep any wrapped-WETH dust back to the wallet (non-critical).
  if (hasWrapped) {
    batch.push({
      target: params.executor,
      value: BigInt(0),
      data: encodeSweepToken(RH_WETH, params.account),
      allowFailure: true,
    })
  }

  const feeTokens: Address[] = []
  const tradeAmounts: bigint[] = []
  let ethTrade = params.wethWrapWei
  const erc20 = new Map<string, bigint>()
  for (const leg of params.legs) {
    if (leg.nativeIn) {
      ethTrade += leg.swapValueWei
      continue
    }
    if (!leg.tokenIn) continue
    const notional = leg.feeNotional ?? leg.pullAmount
    if (notional <= BigInt(0)) continue
    const key = leg.tokenIn.toLowerCase()
    erc20.set(key, (erc20.get(key) ?? BigInt(0)) + notional)
  }
  if (ethTrade > BigInt(0)) {
    feeTokens.push(RH_NATIVE_FEE_TOKEN)
    tradeAmounts.push(ethTrade)
    txValue += platformFeeAmount(ethTrade)
  }
  for (const [token, amount] of erc20) {
    feeTokens.push(token as Address)
    tradeAmounts.push(amount)
  }

  return { batch, txValue, feeTokens, tradeAmounts }
}
