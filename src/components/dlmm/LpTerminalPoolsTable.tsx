'use client'

import { Fragment, useDeferredValue, useMemo, useState } from 'react'
import { useLpTerminalPools } from '@/hooks/useLpTerminalPools'
import RhUniv2LpSheet from '@/components/dlmm/RhUniv2LpSheet'
import RhClmmLpSheet from '@/components/dlmm/RhClmmLpSheet'
import DlmmFastSwapModal from '@/components/dlmm/DlmmFastSwapModal'
import GmgnChartEmbed from '@/components/signals/shared/GmgnChartEmbed'
import { formatApr, formatUsd } from '@/utils/dlmm/format'
import {
  isRhUniv2QuotePool,
  quoteSymbolForAddress,
} from '@/utils/dlmm/rh-univ2'
import {
  compareNum,
  compareStr,
  sortMarker,
  toggleSort,
  type SortDir,
} from '@/utils/dlmm/table-sort'

type ProtoFilter = '' | 'univ3' | 'univ2' | 'univ4'

type SortKey =
  | 'pair'
  | 'score'
  | 'tvl'
  | 'vol'
  | 'fees'
  | 'apr'
  | 'lps'
  | 'churn'
  | 'demand'
  | 'actions'

const NUMERIC_KEYS = new Set<SortKey>([
  'score',
  'tvl',
  'vol',
  'fees',
  'apr',
  'lps',
  'churn',
  'demand',
])

function fmtNum(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString(undefined, { maximumFractionDigits: digits })
}

type AddTarget =
  | {
      kind: 'v2'
      address: string
      tokenAddress: string
      tokenSymbol?: string
    }
  | {
      kind: 'v1'
      address: string
      proto: string
      pairLabel: string
      tokenAddress: string
      tokenSymbol?: string
    }

function canAddV2(row: { proto: string; token0: string; token1: string }) {
  return String(row.proto).toLowerCase() === 'univ2' && isRhUniv2QuotePool(row)
}

function canAddV1(row: { proto: string }) {
  const p = String(row.proto).toLowerCase()
  return p === 'univ3' || p === 'univ4'
}

function baseFromRow(row: {
  token0: string
  token1: string
  pair: string
}) {
  const q0 = quoteSymbolForAddress(row.token0)
  const q1 = quoteSymbolForAddress(row.token1)
  const base = q0 ? row.token1 : q1 ? row.token0 : row.token0
  const parts = row.pair.split('/')
  const baseSym = q0 ? parts[1]?.trim() : parts[0]?.trim()
  return { tokenAddress: base, tokenSymbol: baseSym }
}

function actionsLabel(row: { proto: string; token0: string; token1: string }) {
  const parts: string[] = ['Swap']
  if (canAddV1(row)) parts.push('Add v1')
  if (canAddV2(row)) parts.push('Add v2')
  return parts.join(' ')
}

function SortTh({
  label,
  col,
  sortKey,
  sortDir,
  align = 'left',
  onSort,
}: {
  label: string
  col: SortKey
  sortKey: SortKey
  sortDir: SortDir
  align?: 'left' | 'right'
  onSort: (col: SortKey) => void
}) {
  const active = sortKey === col
  return (
    <th
      className={`px-3 py-2 font-normal ${align === 'right' ? 'text-right' : ''}`}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`uppercase tracking-wide hover:text-gray-300 ${
          active ? 'text-emerald-400' : ''
        }`}
      >
        {label}
        {sortMarker(active, sortDir)}
      </button>
    </th>
  )
}

export default function LpTerminalPoolsTable() {
  const [q, setQ] = useState('')
  const deferredQ = useDeferredValue(q)
  const [proto, setProto] = useState<ProtoFilter>('')
  const [hideDust, setHideDust] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [addTarget, setAddTarget] = useState<AddTarget | null>(null)
  const [swapTarget, setSwapTarget] = useState<{
    tokenAddress: string
    tokenSymbol?: string
    pairLabel: string
  } | null>(null)

  const {
    rows,
    count,
    totals,
    ready,
    indexer,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useLpTerminalPools(true, {
    q: deferredQ,
    proto,
    hideDust,
    sort: 'fees',
    limit: 100,
  })

  // Score only exists when the indexer is live; on fallback, score-sort degrades to fees.
  const effectiveSortKey: SortKey =
    sortKey === 'score' && !indexer ? 'fees' : sortKey

  const sortedRows = useMemo(() => {
    const list = [...rows]
    list.sort((a, b) => {
      switch (effectiveSortKey) {
        case 'pair':
          return compareStr(a.pair, b.pair, sortDir)
        case 'score':
          return compareNum(a.score ?? 0, b.score ?? 0, sortDir)
        case 'tvl':
          return compareNum(a.tvlUsd, b.tvlUsd, sortDir)
        case 'vol':
          return compareNum(a.vol24hUsd, b.vol24hUsd, sortDir)
        case 'fees':
          return compareNum(a.fees24hUsd, b.fees24hUsd, sortDir)
        case 'apr':
          return compareNum(a.feeAprPct, b.feeAprPct, sortDir)
        case 'lps':
          return compareNum(a.lpCount ?? 0, b.lpCount ?? 0, sortDir)
        case 'churn':
          return compareNum(a.churn ?? 0, b.churn ?? 0, sortDir)
        case 'demand':
          return compareNum(a.demandUsd ?? 0, b.demandUsd ?? 0, sortDir)
        case 'actions':
          return compareStr(actionsLabel(a), actionsLabel(b), sortDir)
        default:
          return 0
      }
    })
    return list
  }, [rows, effectiveSortKey, sortDir])

  const indexerChip = useMemo(() => {
    if (!indexer) {
      return { cls: 'border-gray-700 text-gray-500', text: 'indexer offline · fallback' }
    }
    const lag = indexer.lag_s == null ? 'lag ?' : `lag ${Math.round(indexer.lag_s)}s`
    const conf = `${Math.round(indexer.confidence * 100)}%`
    if (indexer.no_trade) {
      return { cls: 'border-red-700 text-red-300 bg-red-950/40', text: `${lag} · conf ${conf} · NO TRADE` }
    }
    if (indexer.confidence < 0.7) {
      return { cls: 'border-amber-700 text-amber-300', text: `${lag} · conf ${conf}` }
    }
    return { cls: 'border-emerald-700 text-emerald-300', text: `${lag} · conf ${conf}` }
  }, [indexer])

  const statusLine = useMemo(() => {
    const catalog =
      (totals.univ2 || 0) + (totals.univ3 || 0) + (totals.univ4 || 0)
    return `${sortedRows.length} shown · uniswap catalog ${catalog.toLocaleString()}${
      count ? ` · ${count.toLocaleString()} match` : ''
    }${!ready ? ' · indexer warming…' : ''}`
  }, [sortedRows.length, totals, count, ready])

  const onSort = (col: SortKey) => {
    const next = toggleSort(sortKey, sortDir, col, {
      numericFirstDesc: NUMERIC_KEYS.has(col),
    })
    setSortKey(next.key)
    setSortDir(next.dir)
  }

  const chip = (id: ProtoFilter | 'dust', label: string, active: boolean) => (
    <button
      key={id}
      type="button"
      onClick={() => {
        if (id === 'dust') {
          setHideDust((v) => !v)
          return
        }
        setProto(id)
      }}
      className={`shrink-0 px-2 py-1 text-xs font-mono uppercase tracking-wide border ${
        active
          ? 'border-emerald-500 text-emerald-300 bg-emerald-950/40'
          : 'border-gray-700 text-gray-400 hover:border-gray-500'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="space-y-3 font-mono">
      <div className="flex flex-col lg:flex-row gap-2 lg:items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="pair / symbol / token or pool address"
          className="flex-1 bg-black border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded-none focus:outline-none focus:border-emerald-600"
        />
        <div className="flex flex-wrap gap-1.5">
          {chip('', 'ALL', proto === '')}
          {chip('univ4', 'UNI V4', proto === 'univ4')}
          {chip('univ3', 'UNI V3', proto === 'univ3')}
          {chip('univ2', 'UNI V2', proto === 'univ2')}
          {chip('dust', hideDust ? 'HIDE <$1K' : 'SHOW DUST', hideDust)}
          <span
            title={indexer?.reasons.join(' · ') || 'robinhoodpools.lol /api/lp/status'}
            className={`shrink-0 px-2 py-1 text-xs font-mono uppercase tracking-wide border ${indexerChip.cls}`}
          >
            {indexerChip.text}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 border border-gray-700 disabled:opacity-50"
        >
          {isFetching ? '…' : '↻'}
        </button>
      </div>

      <p className="text-xs text-gray-500">
        {statusLine}
        {' · '}
        <span className="text-gray-400">
          Add v1 = CLMM UniV3/V4 · Add v2 = DAMM UniV2 zap · click Pair for GMGN
        </span>
      </p>

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading pools from Robinhood Pools indexer…</p>
      ) : error ? (
        <p className="text-red-400 text-sm">
          {error instanceof Error ? error.message : 'Failed to load pools'}
        </p>
      ) : sortedRows.length === 0 ? (
        <p className="text-gray-500 text-sm">No pools match.</p>
      ) : (
        <div className="overflow-x-auto border border-gray-800">
          <table className="w-full text-xs text-left">
            <thead className="text-gray-500 border-b border-gray-800 uppercase tracking-wide">
              <tr>
                <SortTh
                  label="Pair"
                  col="pair"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortTh
                  label="Score"
                  col="score"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
                <SortTh
                  label="TVL"
                  col="tvl"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
                <SortTh
                  label="Vol 24h"
                  col="vol"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
                <SortTh
                  label="Fees 24h"
                  col="fees"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
                <SortTh
                  label="Fee APR"
                  col="apr"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
                <SortTh
                  label="LPs"
                  col="lps"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
                <SortTh
                  label="Churn"
                  col="churn"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
                <SortTh
                  label="Demand"
                  col="demand"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
                <SortTh
                  label="Actions"
                  col="actions"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  align="right"
                  onSort={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const rowKey = `${row.proto}-${row.address}`
                const open = expandedKey === rowKey
                const { tokenAddress, tokenSymbol } = baseFromRow(row)
                return (
                  <Fragment key={rowKey}>
                    <tr className="border-b border-gray-900 hover:bg-gray-900/60">
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedKey(open ? null : rowKey)
                          }
                          className="text-left w-full hover:opacity-90"
                          title="Toggle GMGN chart"
                        >
                          <div className="text-gray-100">
                            {row.pair}
                            {open ? ' ▾' : ' ▸'}
                          </div>
                          <div className="text-xs text-gray-600">
                            {row.protoLabel.toLowerCase()} · {row.feeTier}
                            {row.risks.length > 0 ? (
                              <span
                                className="ml-1 text-amber-500/80"
                                title={row.risks.join('\n')}
                              >
                                ⚠ {row.risks.length}
                              </span>
                            ) : null}
                          </div>
                        </button>
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right tabular-nums ${
                          (row.score ?? 0) >= 40
                            ? 'text-emerald-300'
                            : (row.score ?? 0) > 0
                              ? 'text-gray-200'
                              : 'text-gray-600'
                        }`}
                        title={row.scoreReasons.join(' · ') || undefined}
                      >
                        {row.score == null ? '—' : fmtNum(row.score, 1)}
                      </td>
                      <td
                        className="px-3 py-2.5 text-right tabular-nums text-gray-200"
                        title={row.tvlApprox ? 'TVL unverified (indexer null / approx)' : undefined}
                      >
                        {row.tvlApprox ? '~' : ''}
                        {formatUsd(row.tvlUsd)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {formatUsd(row.vol24hUsd)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-amber-400/90">
                        {formatUsd(row.fees24hUsd)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {formatApr(row.feeAprPct)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-300">
                        {fmtNum(row.lpCount)}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right tabular-nums ${
                          (row.churn ?? 0) > 10 ? 'text-amber-400' : 'text-gray-300'
                        }`}
                        title="(adds + removes) / LPs, 24h"
                      >
                        {fmtNum(row.churn, 1)}
                      </td>
                      <td
                        className="px-3 py-2.5 text-right tabular-nums text-sky-300/90"
                        title="Trenches organic cash-leg buys, 24h"
                      >
                        {row.demandUsd == null ? '—' : formatUsd(row.demandUsd)}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1">
                        {tokenAddress ? (
                          <button
                            type="button"
                            onClick={() =>
                              setSwapTarget({
                                tokenAddress,
                                tokenSymbol,
                                pairLabel: row.pair,
                              })
                            }
                            className="inline-flex items-center gap-1 px-2 py-1 border border-violet-700 text-violet-300 hover:bg-violet-950/50"
                          >
                            Swap
                          </button>
                        ) : null}
                        {canAddV1(row) ? (
                          <button
                            type="button"
                            onClick={() => {
                              setAddTarget({
                                kind: 'v1',
                                address: row.address,
                                proto: String(row.proto).toLowerCase(),
                                pairLabel: row.pair,
                                tokenAddress,
                                tokenSymbol,
                              })
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 border border-sky-700 text-sky-300 hover:bg-sky-950/50"
                          >
                            Add v1
                          </button>
                        ) : null}
                        {canAddV2(row) ? (
                          <button
                            type="button"
                            onClick={() => {
                              setAddTarget({
                                kind: 'v2',
                                address: row.address,
                                tokenAddress,
                                tokenSymbol,
                              })
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 border border-emerald-700 text-emerald-300 hover:bg-emerald-950/50"
                          >
                            Add v2
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {open && tokenAddress ? (
                      <tr className="border-b border-gray-900 bg-gray-950/40">
                        <td colSpan={10} className="px-3 py-3">
                          <div className="relative h-[280px] w-full">
                            <GmgnChartEmbed
                              tokenAddress={tokenAddress}
                              chain="robinhood"
                              interval="5"
                              className="w-full h-full"
                              height="280px"
                              title={`GMGN · ${row.pair}`}
                            />
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {addTarget?.kind === 'v2' ? (
        <RhUniv2LpSheet
          open
          onClose={() => setAddTarget(null)}
          poolAddress={addTarget.address}
          tokenAddress={addTarget.tokenAddress}
          tokenSymbol={addTarget.tokenSymbol}
        />
      ) : null}

      {addTarget?.kind === 'v1' ? (
        <RhClmmLpSheet
          open
          onClose={() => setAddTarget(null)}
          poolAddress={addTarget.address}
          proto={addTarget.proto}
          pairLabel={addTarget.pairLabel}
          tokenAddress={addTarget.tokenAddress}
          tokenSymbol={addTarget.tokenSymbol}
        />
      ) : null}

      <DlmmFastSwapModal
        open={Boolean(swapTarget)}
        onClose={() => setSwapTarget(null)}
        network="robinhood"
        tokenAddress={swapTarget?.tokenAddress ?? ''}
        tokenSymbol={swapTarget?.tokenSymbol}
        pairLabel={swapTarget?.pairLabel}
      />
    </div>
  )
}
