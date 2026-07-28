'use client'

import { useMemo, useState, type ReactNode } from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import {
  usePatchRhClmmMark,
  useRhClmmMarks,
} from '@/hooks/useRhClmmPositions'
import {
  usePatchRhUniv2Position,
  useRhUniv2Positions,
} from '@/hooks/useRhUniv2Positions'
import { useLpTerminalPools } from '@/hooks/useLpTerminalPools'
import RhClmmClaimFeesSheet from '@/components/dlmm/RhClmmClaimFeesSheet'
import RhUniv2LpSheet from '@/components/dlmm/RhUniv2LpSheet'
import {
  closeOwnerPosition,
  type RhClmmCtx,
} from '@/utils/dlmm/rh-clmm'
import type { OnChainPosition } from '@/utils/dlmm/rh-clmm/positions'
import type {
  RhClmmLiveRow,
  RhClmmPosition,
  RhUniv2Position,
} from '@/types/dlmm'
import { liveRowToOnChain } from '@/utils/dlmm/rh-clmm-live-row'
import { formatApr, formatUsd } from '@/utils/dlmm/format'
import {
  alreadyEmptyNotice,
  clmmPositionKey,
  findOrphanOpenMarkIds,
  isAlreadyEmptyCloseError,
} from '@/utils/dlmm/rh-clmm-already-empty'

type StatusFilter = 'open' | 'oor' | 'closed'

type UnifiedRow = {
  key: string
  kind: 'clmm' | 'damm'
  pair: string
  protocolLabel: string
  valueUsd: number
  unclaimedUsd: number
  inRange: boolean | null
  pnlPct: number | null
  aprPct: number | null
  ageMs: number | null
  poolAddress: string
  live: boolean
  clmm?: OnChainPosition
  clmmMarkId?: string
  damm?: RhUniv2Position
  closedClmm?: RhClmmPosition
  closedDamm?: RhUniv2Position
}

function fmtAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${(h / 24).toFixed(1)}d`
}

function fmtPnl(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}%`
}

function ageFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Date.now() - t
}

function SkeletonRows({ count }: { count: number }) {
  const n = Math.max(3, count)
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <tr key={`sk-${i}`} className="border-b border-gray-800 animate-pulse">
          <td className="py-3 pr-3">
            <div className="h-3 w-28 rounded bg-gray-800 mb-1.5" />
            <div className="h-2 w-16 rounded bg-gray-800/70" />
          </td>
          <td className="py-3 pr-3">
            <div className="h-3 w-14 rounded bg-gray-800 ml-auto" />
          </td>
          <td className="py-3 pr-3">
            <div className="h-3 w-12 rounded bg-gray-800 ml-auto" />
          </td>
          <td className="py-3 pr-3">
            <div className="h-2 w-16 rounded bg-gray-800" />
          </td>
          <td className="py-3 pr-3">
            <div className="h-3 w-12 rounded bg-gray-800 ml-auto" />
          </td>
          <td className="py-3 pr-3">
            <div className="h-3 w-10 rounded bg-gray-800 ml-auto" />
          </td>
          <td className="py-3 pr-3">
            <div className="h-3 w-8 rounded bg-gray-800 ml-auto" />
          </td>
          <td className="py-3 pr-3">
            <div className="h-6 w-20 rounded bg-gray-800 ml-auto" />
          </td>
        </tr>
      ))}
    </>
  )
}

function PositionsTableShell({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-left">
        <thead className="text-gray-400 border-b border-gray-700 text-[11px] uppercase tracking-wide">
          <tr>
            <th className="py-2 pr-3">Pool</th>
            <th className="py-2 pr-3 text-right">Value</th>
            <th className="py-2 pr-3 text-right">Unclaimed</th>
            <th className="py-2 pr-3">Range</th>
            <th className="py-2 pr-3 text-right">PnL</th>
            <th className="py-2 pr-3 text-right">APR</th>
            <th className="py-2 pr-3 text-right">Age</th>
            <th className="py-2 pr-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

async function fetchRhClmmLive(
  owner: string,
  fresh: boolean,
): Promise<RhClmmLiveRow[]> {
  const qs = new URLSearchParams({ owner, chain: 'robinhood' })
  if (fresh) qs.set('fresh', '1')
  const res = await fetch(`/api/dlmm/rh-clmm-live?${qs}`, {
    headers: { 'x-app-network': 'robinhood' },
  })
  const data = (await res.json()) as {
    success?: boolean
    error?: string
    positions?: RhClmmLiveRow[]
  }
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to load CLMM live')
  }
  return data.positions ?? []
}

export default function RhPositionsPanel() {
  const wallet = useRhEvmWallet()
  const queryClient = useQueryClient()
  const patchClmm = usePatchRhClmmMark()
  const patchDamm = usePatchRhUniv2Position()
  const [filter, setFilter] = useState<StatusFilter>('open')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [claimTarget, setClaimTarget] = useState<OnChainPosition | null>(null)
  const [closeDamm, setCloseDamm] = useState<RhUniv2Position | null>(null)

  const { data: openMarksData, refetch: refetchOpenMarks } = useRhClmmMarks(
    wallet.address,
    'open',
  )
  const { data: closedClmmData, refetch: refetchClosedClmm } = useRhClmmMarks(
    wallet.address,
    'closed',
  )
  const openMarks = useMemo(
    () => openMarksData?.positions ?? [],
    [openMarksData?.positions],
  )
  const closedClmmMarks = useMemo(
    () => closedClmmData?.positions ?? [],
    [closedClmmData?.positions],
  )

  const markByKey = useMemo(() => {
    const map = new Map<string, RhClmmPosition>()
    for (const m of openMarks) {
      map.set(`${m.protocol}:${m.token_id}`, m)
    }
    return map
  }, [openMarks])

  const dammOpenQ = useRhUniv2Positions('open')
  const dammClosedQ = useRhUniv2Positions('closed')

  const ownerLc = wallet.address?.toLowerCase() ?? ''
  const dammOpen = useMemo(
    () =>
      (dammOpenQ.data?.positions ?? []).filter(
        (p) => !ownerLc || p.owner_address.toLowerCase() === ownerLc,
      ),
    [dammOpenQ.data?.positions, ownerLc],
  )
  const dammClosed = useMemo(
    () =>
      (dammClosedQ.data?.positions ?? []).filter(
        (p) => !ownerLc || p.owner_address.toLowerCase() === ownerLc,
      ),
    [dammClosedQ.data?.positions, ownerLc],
  )

  const pools = useLpTerminalPools(true, {
    hideDust: false,
    sort: 'vol',
    limit: 200,
  })
  const aprByPool = useMemo(() => {
    const map = new Map<string, number | null>()
    for (const r of pools.rows) {
      map.set(r.address.toLowerCase(), r.feeAprPct)
    }
    return map
  }, [pools.rows])

  async function ctx(): Promise<RhClmmCtx> {
    if (!wallet.address) throw new Error('Connect Rabby first')
    const walletClient = await wallet.getWalletClient()
    return {
      publicClient: wallet.publicClient,
      walletClient,
      owner: wallet.address,
    }
  }

  const liveQueryKey = ['rh-clmm-live', wallet.address] as const

  const liveQuery = useQuery({
    queryKey: liveQueryKey,
    enabled: Boolean(wallet.address),
    staleTime: 25_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => fetchRhClmmLive(wallet.address!, false),
  })

  const liveRows = useMemo(() => liveQuery.data ?? [], [liveQuery.data])
  const isRefreshing = busy === 'refresh'

  async function afterClmmMarkClosed() {
    const live = await fetchRhClmmLive(wallet.address!, true)
    queryClient.setQueryData(liveQueryKey, live)
    await refetchOpenMarks()
    await refetchClosedClmm()
  }

  async function markClmmAlreadyEmpty(markId: string) {
    // Keep last value/PnL; omit close_tx (no on-chain burn).
    await patchClmm.mutateAsync({ id: markId, status: 'closed' })
  }

  async function refreshAll() {
    setError(null)
    setNotice(null)
    setBusy('refresh')
    try {
      const [live, openResult] = await Promise.all([
        fetchRhClmmLive(wallet.address!, true),
        refetchOpenMarks(),
        refetchClosedClmm(),
        dammOpenQ.refetch(),
        dammClosedQ.refetch(),
        patchDamm.mutateAsync({ action: 'refresh_all' }).catch(() => null),
      ])
      queryClient.setQueryData(liveQueryKey, live)

      const marks = openResult.data?.positions ?? []
      const liveKeys = new Set(
        live.map((r) => clmmPositionKey(r.protocol, r.tokenId)),
      )
      const orphans = findOrphanOpenMarkIds(marks, liveKeys)
      if (orphans.length > 0) {
        for (const o of orphans) {
          await markClmmAlreadyEmpty(o.markId)
        }
        setNotice(alreadyEmptyNotice(orphans.map((o) => o.tokenId)))
        await refetchOpenMarks()
        await refetchClosedClmm()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setBusy(null)
    }
  }

  async function runCloseClmm(
    tokenId: bigint,
    protocol: 'v3' | 'v4',
    markId?: string,
  ) {
    setError(null)
    setNotice(null)
    setBusy(`close-${tokenId}`)
    try {
      const c = await ctx()
      const result = await closeOwnerPosition(c, tokenId, protocol)
      if (markId) {
        await patchClmm.mutateAsync({
          id: markId,
          status: 'closed',
          close_tx: result.hash,
          current_value_usd: 0,
          pnl_pct: 0,
        })
      }
      // Same path as manual Refresh — do not re-serve stale Redis via fresh=false.
      await afterClmmMarkClosed()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Close failed'
      if (markId && isAlreadyEmptyCloseError(msg)) {
        try {
          await markClmmAlreadyEmpty(markId)
          await afterClmmMarkClosed()
          setNotice(alreadyEmptyNotice([String(tokenId)]))
          return
        } catch (patchErr) {
          setError(
            patchErr instanceof Error ? patchErr.message : 'Failed to mark closed',
          )
          return
        }
      }
      setError(msg)
    } finally {
      setBusy(null)
    }
  }

  const openRows: UnifiedRow[] = useMemo(() => {
    const byKey = new Map<string, UnifiedRow>()

    // Seed CLMM from marks first (instant paint)
    for (const m of openMarks) {
      const key = `${m.protocol}:${m.token_id}`
      byKey.set(key, {
        key: `clmm-${key}`,
        kind: 'clmm',
        pair: m.pair_label || `#${m.token_id}`,
        protocolLabel: m.protocol.toUpperCase(),
        valueUsd: m.current_value_usd || m.entry_value_usd || 0,
        unclaimedUsd: m.unclaimed_fees_usd ?? 0,
        inRange: m.in_range ?? null,
        pnlPct: Number.isFinite(m.pnl_pct) ? m.pnl_pct : null,
        aprPct: aprByPool.get(m.pool_address.toLowerCase()) ?? null,
        ageMs: ageFromIso(m.created_at),
        poolAddress: m.pool_address,
        live: Boolean(m.live_synced_at),
        clmmMarkId: m.id,
        clmm:
          m.live_synced_at && m.symbol0
            ? liveRowToOnChain({
                tokenId: m.token_id,
                protocol: m.protocol,
                poolAddress: m.pool_address,
                pairLabel: m.pair_label || `${m.symbol0}/${m.symbol1}`,
                symbol0: m.symbol0 ?? '?',
                symbol1: m.symbol1 ?? '?',
                decimals0: 18,
                decimals1: 18,
                valueUsd: m.current_value_usd,
                unclaimedFeesUsd: m.unclaimed_fees_usd ?? 0,
                inRange: m.in_range ?? true,
                tickLower: m.tick_lower ?? 0,
                tickUpper: m.tick_upper ?? 0,
                liquidity: m.liquidity ?? '0',
                tokensOwed0: '0',
                tokensOwed1: '0',
                token0: '0x0000000000000000000000000000000000000000',
                token1: '0x0000000000000000000000000000000000000000',
                markId: m.id,
              })
            : undefined,
      })
    }

    // Enrich from Redis/API live snapshot — only for marks still open.
    // Live-only rows after a close must not resurrect into the Open list.
    for (const r of liveRows) {
      const key = `${r.protocol}:${r.tokenId}`
      const mark = markByKey.get(key)
      if (!mark) continue
      const entry = r.entryValueUsd ?? mark.entry_value_usd ?? 0
      const pnl =
        r.pnlPct != null
          ? r.pnlPct
          : entry > 0
            ? ((r.valueUsd - entry) / entry) * 100
            : (mark.pnl_pct ?? null)
      const poolAddr = r.poolAddress || mark.pool_address || ''
      byKey.set(key, {
        key: `clmm-${key}`,
        kind: 'clmm',
        pair: r.pairLabel,
        protocolLabel: r.protocol.toUpperCase(),
        valueUsd: r.valueUsd,
        unclaimedUsd: r.unclaimedFeesUsd,
        inRange: r.inRange,
        pnlPct: pnl != null && Number.isFinite(pnl) ? pnl : null,
        aprPct: poolAddr
          ? (aprByPool.get(poolAddr.toLowerCase()) ?? null)
          : null,
        ageMs: ageFromIso(r.createdAt ?? mark.created_at),
        poolAddress: poolAddr,
        live: true,
        clmm: liveRowToOnChain(r),
        clmmMarkId: r.markId ?? mark.id,
      })
    }

    const rows = [...byKey.values()]
    for (const p of dammOpen) {
      rows.push({
        key: `damm-${p.id}`,
        kind: 'damm',
        pair: p.pair_label || p.pool_address.slice(0, 10),
        protocolLabel: 'V2',
        valueUsd: p.current_value_usd,
        unclaimedUsd: 0,
        inRange: null,
        pnlPct: Number.isFinite(p.pnl_pct) ? p.pnl_pct : null,
        aprPct: aprByPool.get(p.pool_address.toLowerCase()) ?? null,
        ageMs: ageFromIso(p.created_at),
        poolAddress: p.pool_address,
        live: true,
        damm: p,
      })
    }
    return rows
  }, [openMarks, liveRows, markByKey, dammOpen, aprByPool])

  const closedRows: UnifiedRow[] = useMemo(() => {
    const rows: UnifiedRow[] = []
    for (const m of closedClmmMarks) {
      rows.push({
        key: `clmm-closed-${m.id}`,
        kind: 'clmm',
        pair: m.pair_label || `#${m.token_id}`,
        protocolLabel: m.protocol.toUpperCase(),
        valueUsd: m.current_value_usd,
        unclaimedUsd: 0,
        inRange: null,
        pnlPct: Number.isFinite(m.pnl_pct) ? m.pnl_pct : null,
        aprPct: aprByPool.get(m.pool_address.toLowerCase()) ?? null,
        ageMs: ageFromIso(m.closed_at ?? m.created_at),
        poolAddress: m.pool_address,
        live: true,
        closedClmm: m,
      })
    }
    for (const p of dammClosed) {
      rows.push({
        key: `damm-closed-${p.id}`,
        kind: 'damm',
        pair: p.pair_label || p.pool_address.slice(0, 10),
        protocolLabel: 'V2',
        valueUsd: p.current_value_usd,
        unclaimedUsd: 0,
        inRange: null,
        pnlPct: Number.isFinite(p.pnl_pct) ? p.pnl_pct : null,
        aprPct: aprByPool.get(p.pool_address.toLowerCase()) ?? null,
        ageMs: ageFromIso(p.closed_at ?? p.created_at),
        poolAddress: p.pool_address,
        live: true,
        closedDamm: p,
      })
    }
    return rows
  }, [closedClmmMarks, dammClosed, aprByPool])

  const visible = useMemo(() => {
    if (filter === 'closed') return closedRows
    if (filter === 'oor') {
      return openRows.filter((r) => r.kind === 'clmm' && r.inRange === false)
    }
    return openRows
  }, [filter, openRows, closedRows])

  const totalValue = useMemo(
    () => openRows.reduce((s, r) => s + (r.valueUsd || 0), 0),
    [openRows],
  )
  const totalUnclaimed = useMemo(
    () => openRows.reduce((s, r) => s + (r.unclaimedUsd || 0), 0),
    [openRows],
  )
  const firstClaimable = useMemo(
    () =>
      openRows.find(
        (r) =>
          r.kind === 'clmm' &&
          r.clmm &&
          (r.clmm.tokensOwed0 > BigInt(0) || r.clmm.tokensOwed1 > BigInt(0)),
      )?.clmm ?? null,
    [openRows],
  )

  const openCount = openRows.length
  const oorCount = openRows.filter(
    (r) => r.kind === 'clmm' && r.inRange === false,
  ).length
  const closedCount = closedRows.length

  const marksReady = openMarks.length > 0 || dammOpen.length > 0
  const coldSkeleton =
    Boolean(wallet.address) &&
    !isRefreshing &&
    !marksReady &&
    liveQuery.isLoading &&
    openRows.length === 0 &&
    filter !== 'closed'

  const showEmpty =
    Boolean(wallet.address) &&
    !isRefreshing &&
    !coldSkeleton &&
    visible.length === 0

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Positions</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            CLMM + DAMM v2 · Rabby on chain 4663
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!wallet.address ? (
            <button
              type="button"
              onClick={() => void wallet.connect()}
              disabled={wallet.connecting || !wallet.hasProvider}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-sm rounded"
            >
              {!wallet.hasProvider
                ? 'No Rabby'
                : wallet.connecting
                  ? 'Connecting…'
                  : 'Connect Rabby'}
            </button>
          ) : (
            <span className="text-xs text-gray-400 font-mono">
              {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
              {!wallet.isCorrectChain ? ' · switch to RH (4663)' : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={isRefreshing || !wallet.address || !!busy}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs border border-gray-600 text-gray-300 hover:border-emerald-600 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span
              className={`inline-block ${isRefreshing ? 'animate-spin' : ''}`}
              aria-hidden
            >
              ↻
            </span>
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 border border-gray-800 rounded-lg px-4 py-3 bg-black/30">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500">
            Total value
          </div>
          <div className="text-lg font-semibold text-white tabular-nums">
            {formatUsd(totalValue)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500">
            Unclaimed fees
          </div>
          <div className="text-lg font-semibold text-amber-400/90 tabular-nums">
            {formatUsd(totalUnclaimed)}
          </div>
        </div>
        <button
          type="button"
          disabled={!firstClaimable || !!busy || isRefreshing}
          onClick={() => firstClaimable && setClaimTarget(firstClaimable)}
          className="ml-auto px-3 py-1.5 text-sm rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 text-white"
        >
          Claim
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['open', `Open (${openCount})`],
            ['oor', `Out of range (${oorCount})`],
            ['closed', `Closed (${closedCount})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            disabled={isRefreshing}
            className={`px-3 py-1.5 text-xs font-medium rounded ${
              filter === id
                ? 'bg-emerald-600 text-black'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            } disabled:opacity-50`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <p className="text-sm text-red-400 break-words">{error}</p>
      ) : null}
      {notice ? (
        <p className="text-sm text-emerald-400/90 break-words">{notice}</p>
      ) : null}

      {!wallet.address ? (
        <p className="text-gray-500 text-sm">
          Connect Rabby to list on-chain CLMM + your DAMM marks.
        </p>
      ) : isRefreshing || coldSkeleton ? (
        <PositionsTableShell>
          <SkeletonRows count={isRefreshing ? visible.length : 4} />
        </PositionsTableShell>
      ) : showEmpty ? (
        <p className="text-gray-500 text-sm">
          {filter === 'closed'
            ? 'No closed position marks.'
            : filter === 'oor'
              ? 'No out-of-range CLMM positions.'
              : 'No open positions.'}
        </p>
      ) : (
        <PositionsTableShell>
          {visible.map((r) => {
            const isClosed = filter === 'closed'
            const canClaim =
              !isClosed &&
              r.kind === 'clmm' &&
              r.live &&
              r.clmm &&
              (r.clmm.tokensOwed0 > BigInt(0) ||
                r.clmm.tokensOwed1 > BigInt(0))
            const clmmActionsReady = r.kind === 'clmm' && r.live && !!r.clmm
            return (
              <tr
                key={r.key}
                className="border-b border-gray-800 text-gray-200"
              >
                <td className="py-2.5 pr-3">
                  <div className="text-white">{r.pair}</div>
                  <div className="text-[10px] text-gray-500">
                    {r.protocolLabel}
                    {r.clmm
                      ? ` · #${r.clmm.tokenId.toString()}`
                      : r.closedClmm
                        ? ` · #${r.closedClmm.token_id}`
                        : r.clmmMarkId
                          ? ' · mark'
                          : ''}
                    {r.kind === 'clmm' && !r.live && !isClosed
                      ? ' · syncing…'
                      : ''}
                  </div>
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums">
                  {formatUsd(r.valueUsd)}
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums text-emerald-400/90">
                  {r.live && r.unclaimedUsd > 0
                    ? formatUsd(r.unclaimedUsd)
                    : '—'}
                </td>
                <td className="py-2.5 pr-3">
                  {r.kind === 'damm' || isClosed ? (
                    <span className="text-xs text-gray-500">full</span>
                  ) : r.inRange == null ? (
                    <span className="text-xs text-gray-600">—</span>
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs ${
                        r.inRange ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-10 rounded-full ${
                          r.inRange ? 'bg-emerald-600' : 'bg-red-700'
                        }`}
                      />
                      {r.inRange ? 'In' : 'OOR'}
                    </span>
                  )}
                </td>
                <td
                  className={`py-2.5 pr-3 text-right tabular-nums ${
                    r.pnlPct != null && r.pnlPct >= 0
                      ? 'text-emerald-400'
                      : r.pnlPct != null
                        ? 'text-red-400'
                        : 'text-gray-500'
                  }`}
                >
                  {fmtPnl(r.pnlPct)}
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums text-gray-300">
                  {formatApr(r.aprPct)}
                </td>
                <td className="py-2.5 pr-3 text-right text-gray-400">
                  {fmtAge(r.ageMs)}
                </td>
                <td className="py-2.5 pr-3 text-right whitespace-nowrap space-x-1">
                  {isClosed ? (
                    <span className="text-xs text-gray-600">—</span>
                  ) : r.kind === 'clmm' ? (
                    <>
                      <button
                        type="button"
                        disabled={!canClaim || !!busy}
                        onClick={() => r.clmm && setClaimTarget(r.clmm)}
                        className="text-xs px-2 py-1 rounded bg-amber-800 hover:bg-amber-700 disabled:bg-gray-800 text-white"
                      >
                        Claim
                      </button>
                      <button
                        type="button"
                        disabled={!clmmActionsReady || !!busy}
                        onClick={() =>
                          r.clmm &&
                          void runCloseClmm(
                            r.clmm.tokenId,
                            r.clmm.protocol,
                            r.clmmMarkId,
                          )
                        }
                        className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 disabled:bg-gray-800 text-white"
                      >
                        Close
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={!!busy || !r.damm}
                      onClick={() => r.damm && setCloseDamm(r.damm)}
                      className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 disabled:bg-gray-800 text-white"
                    >
                      Close
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </PositionsTableShell>
      )}

      {claimTarget ? (
        <RhClmmClaimFeesSheet
          open
          position={claimTarget}
          onClose={() => setClaimTarget(null)}
          onDone={() => {
            setClaimTarget(null)
            void (async () => {
              if (!wallet.address) return
              const live = await fetchRhClmmLive(wallet.address, true)
              queryClient.setQueryData(liveQueryKey, live)
            })()
          }}
        />
      ) : null}

      {closeDamm ? (
        <RhUniv2LpSheet
          open
          onClose={() => {
            setCloseDamm(null)
            void dammOpenQ.refetch()
          }}
          closePosition={closeDamm}
        />
      ) : null}
    </section>
  )
}
