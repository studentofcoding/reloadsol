/**
 * RH CLMM manage cycle — alert-only (rec 3.1 phase A).
 *
 * Read-only: lists open positions from the DB ledger, checks out-of-range
 * status and claimable fees via RPC reads (Multicall3), and sends Telegram
 * alerts. No signing, no on-chain writes, no DB writes.
 *
 * Server-only (imports ioredis / pg) — never import from browser bundles.
 */

import { createPublicClient, http, pad, toHex, type Address, type Hex } from 'viem'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import { listRhClmmPositions } from '@/utils/dlmm/rh-clmm-db'
import { RH_CHAIN, getRhRpcUrl } from '@/utils/dlmm/rh-univ2'
import { CHAINS, RH_CHAIN_ID } from '@/utils/dlmm/rh-clmm/config'
import { stateViewAbi, v4PositionManagerAbi } from '@/utils/dlmm/rh-clmm/abis'
import {
  computePoolId,
  decodeV4PositionInfo,
  type V4PoolKey,
} from '@/utils/dlmm/rh-clmm/v4'
import { feesFromGrowth } from '@/utils/dlmm/rh-clmm/fees'
import { getTokenPriceUsd } from '@/utils/dlmm/rh-clmm/dexscreener'
import { getTokenMeta, humanToFloat } from '@/utils/dlmm/rh-clmm/tokens'
import { sendTelegramAlert } from '@/utils/telegram'
import {
  formatRhClmmManageAlert,
  rhClmmManageAlertKey,
  shouldAlertFees,
  type RhClmmManageAlertKind,
} from '@/utils/dlmm/rh-clmm-manage-alerts'
import type { RhClmmPosition, RhV4PoolKeyJson } from '@/types/dlmm'

/** Canonical Multicall3 — deployed on Robinhood Chain 4663. */
const MULTICALL3 = '0xca11bde06177c9f5c1b90fd73a40a41c9d3cCA11' as Address

const ALERT_TTL_SEC = 3600 // throttle: at most one alert per position+kind per hour
const MULTICALL_CHUNK = 100

function feeAlertThresholdUsd(): number {
  const raw = process.env.RH_CLMM_FEE_ALERT_USD
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 5
}

export type RhClmmManageCycleResult = {
  success: boolean
  checked: number
  oorCount: number
  alertsSent: number
  alerts: { tokenId: string; kind: RhClmmManageAlertKind }[]
  reason?: string
}

type V4CheckTarget = {
  mark: RhClmmPosition
  tokenId: bigint
  poolKey: V4PoolKey | null
  tickLower: number | null
  tickUpper: number | null
}

function ledgerPoolKey(mark: RhClmmPosition): V4PoolKey | null {
  const k = mark.pool_key as RhV4PoolKeyJson | null | undefined
  if (!k) return null
  if (!k.currency0 || !k.currency1 || !k.hooks) return null
  if (!Number.isFinite(k.fee) || !Number.isFinite(k.tickSpacing)) return null
  return {
    currency0: k.currency0 as Address,
    currency1: k.currency1 as Address,
    fee: Number(k.fee),
    tickSpacing: Number(k.tickSpacing),
    hooks: k.hooks as Address,
  }
}

export async function runRhClmmManageCycle(): Promise<RhClmmManageCycleResult> {
  const out: RhClmmManageCycleResult = {
    success: true,
    checked: 0,
    oorCount: 0,
    alertsSent: 0,
    alerts: [],
  }

  const marks = await listRhClmmPositions('open')
  if (marks.length === 0) return out

  const client = createPublicClient({
    chain: RH_CHAIN,
    transport: http(getRhRpcUrl()),
  })
  const chainCfg = CHAINS[RH_CHAIN_ID]
  const posm = chainCfg.v4PositionManager
  const stateView = chainCfg.v4StateView

  // v4 marks: resolve PoolKey + ticks (ledger first, getPoolAndPositionInfo otherwise)
  const v4Marks = marks.filter((m) => m.protocol === 'v4')
  const targets: V4CheckTarget[] = v4Marks.map((mark) => {
    const key = ledgerPoolKey(mark)
    return {
      mark,
      tokenId: BigInt(mark.token_id),
      poolKey: key,
      tickLower: key != null ? (mark.tick_lower ?? null) : null,
      tickUpper: key != null ? (mark.tick_upper ?? null) : null,
    }
  })

  const needInfo = targets.filter((t) => t.poolKey == null || t.tickLower == null || t.tickUpper == null)
  for (let i = 0; i < needInfo.length; i += MULTICALL_CHUNK) {
    const slice = needInfo.slice(i, i + MULTICALL_CHUNK)
    const results = await client.multicall({
      allowFailure: true,
      multicallAddress: MULTICALL3,
      contracts: slice.map((t) => ({
        address: posm,
        abi: v4PositionManagerAbi,
        functionName: 'getPoolAndPositionInfo' as const,
        args: [t.tokenId] as const,
      })),
    })
    results.forEach((res, idx) => {
      const t = slice[idx]
      if (res.status !== 'success') return
      const raw = res.result as readonly [
        { currency0: Address; currency1: Address; fee: number | bigint; tickSpacing: number | bigint; hooks: Address },
        bigint,
      ]
      t.poolKey = {
        currency0: raw[0].currency0,
        currency1: raw[0].currency1,
        fee: Number(raw[0].fee),
        tickSpacing: Number(raw[0].tickSpacing),
        hooks: raw[0].hooks,
      }
      const decoded = decodeV4PositionInfo(raw[1])
      t.tickLower = decoded.tickLower
      t.tickUpper = decoded.tickUpper
    })
  }

  const readable = targets.filter(
    (t): t is V4CheckTarget & { poolKey: V4PoolKey; tickLower: number; tickUpper: number } =>
      t.poolKey != null && t.tickLower != null && t.tickUpper != null,
  )

  // Batched slot0 for unique pools
  const poolIds = [...new Set(readable.map((t) => computePoolId(t.poolKey)))]
  const tickByPool = new Map<string, number>()
  for (let i = 0; i < poolIds.length; i += MULTICALL_CHUNK) {
    const slice = poolIds.slice(i, i + MULTICALL_CHUNK)
    const results = await client.multicall({
      allowFailure: true,
      multicallAddress: MULTICALL3,
      contracts: slice.map((poolId) => ({
        address: stateView,
        abi: stateViewAbi,
        functionName: 'getSlot0' as const,
        args: [poolId] as const,
      })),
    })
    results.forEach((res, idx) => {
      if (res.status !== 'success') return
      tickByPool.set(slice[idx], Number((res.result as readonly [bigint, number, number, number])[1]))
    })
  }

  // Batched fee-growth reads per position
  const feesByToken = new Map<string, { fees0: bigint; fees1: bigint }>()
  for (let i = 0; i < readable.length; i += Math.floor(MULTICALL_CHUNK / 2)) {
    const slice = readable.slice(i, i + Math.floor(MULTICALL_CHUNK / 2))
    const results = await client.multicall({
      allowFailure: true,
      multicallAddress: MULTICALL3,
      contracts: slice.flatMap((t) => {
        const poolId = computePoolId(t.poolKey)
        const salt = pad(toHex(t.tokenId), { size: 32 })
        return [
          {
            address: stateView,
            abi: stateViewAbi,
            functionName: 'getFeeGrowthInside' as const,
            args: [poolId, t.tickLower, t.tickUpper] as const,
          },
          {
            address: stateView,
            abi: stateViewAbi,
            functionName: 'getPositionInfo' as const,
            args: [poolId, posm, t.tickLower, t.tickUpper, salt] as const,
          },
        ]
      }),
    })
    slice.forEach((t, idx) => {
      const inside = results[idx * 2]
      const posInfo = results[idx * 2 + 1]
      if (inside.status !== 'success' || posInfo.status !== 'success') return
      const [g0, g1] = inside.result as readonly [bigint, bigint]
      const [liq, last0, last1] = posInfo.result as readonly [bigint, bigint, bigint]
      feesByToken.set(t.tokenId.toString(), {
        fees0: feesFromGrowth(g0, last0, liq),
        fees1: feesFromGrowth(g1, last1, liq),
      })
    })
  }

  const thresholdUsd = feeAlertThresholdUsd()

  async function maybeAlert(params: {
    mark: RhClmmPosition
    kind: RhClmmManageAlertKind
    tickLower?: number | null
    tickUpper?: number | null
    currentTick?: number | null
    unclaimedFeesUsd?: number | null
  }): Promise<void> {
    const key = rhClmmManageAlertKey(params.mark.owner_address, params.mark.token_id, params.kind)
    const recent = await cacheGet<number>(key)
    if (recent != null) return
    await cacheSet(key, Date.now(), ALERT_TTL_SEC)
    const text = formatRhClmmManageAlert({
      kind: params.kind,
      pairLabel: params.mark.pair_label ?? `${params.mark.symbol0 ?? '?'}/${params.mark.symbol1 ?? '?'}`,
      protocol: params.mark.protocol,
      tokenId: params.mark.token_id,
      owner: params.mark.owner_address,
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      currentTick: params.currentTick,
      unclaimedFeesUsd: params.unclaimedFeesUsd,
    })
    try {
      await sendTelegramAlert(text, { parseMode: 'HTML' })
      out.alertsSent += 1
      out.alerts.push({ tokenId: params.mark.token_id, kind: params.kind })
    } catch (error) {
      console.warn(
        '[rh-clmm-manage] telegram alert failed:',
        error instanceof Error ? error.message : error,
      )
    }
  }

  // v4 positions: live RPC state
  for (const t of readable) {
    out.checked += 1
    const poolId = computePoolId(t.poolKey)
    const currentTick = tickByPool.get(poolId)
    const inRange =
      currentTick != null ? currentTick >= t.tickLower && currentTick < t.tickUpper : null

    if (inRange === false) {
      out.oorCount += 1
      await maybeAlert({
        mark: t.mark,
        kind: 'oor',
        tickLower: t.tickLower,
        tickUpper: t.tickUpper,
        currentTick,
      })
    }

    const fees = feesByToken.get(t.tokenId.toString())
    if (fees && (fees.fees0 > BigInt(0) || fees.fees1 > BigInt(0))) {
      try {
        const zero = '0x0000000000000000000000000000000000000000'
        const addr0 =
          t.poolKey.currency0.toLowerCase() === zero ? chainCfg.wrapped : t.poolKey.currency0
        const addr1 =
          t.poolKey.currency1.toLowerCase() === zero ? chainCfg.wrapped : t.poolKey.currency1
        const [m0, m1, p0, p1] = await Promise.all([
          getTokenMeta(RH_CHAIN_ID, addr0),
          getTokenMeta(RH_CHAIN_ID, addr1),
          getTokenPriceUsd(RH_CHAIN_ID, addr0),
          getTokenPriceUsd(RH_CHAIN_ID, addr1),
        ])
        const feesUsd =
          humanToFloat(fees.fees0, m0.decimals) * (p0 ?? 0) +
          humanToFloat(fees.fees1, m1.decimals) * (p1 ?? 0)
        if (shouldAlertFees(feesUsd, thresholdUsd)) {
          await maybeAlert({ mark: t.mark, kind: 'fees', unclaimedFeesUsd: feesUsd })
        }
      } catch (error) {
        console.warn(
          `[rh-clmm-manage] fee valuation failed for #${t.mark.token_id}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  // v3 positions: alert from the last live-synced ledger snapshot (no v3 RPC reads here)
  for (const mark of marks.filter((m) => m.protocol === 'v3')) {
    out.checked += 1
    if (mark.in_range === false) {
      out.oorCount += 1
      await maybeAlert({
        mark,
        kind: 'oor',
        tickLower: mark.tick_lower,
        tickUpper: mark.tick_upper,
      })
    }
    if (shouldAlertFees(mark.unclaimed_fees_usd ?? 0, thresholdUsd)) {
      await maybeAlert({ mark, kind: 'fees', unclaimedFeesUsd: mark.unclaimed_fees_usd ?? 0 })
    }
  }

  return out
}
