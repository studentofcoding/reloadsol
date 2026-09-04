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

type ProtoFilter = '' | 'univ3' | 'univ2'

type SortKey =
  | 'pair'
  | 'tvl'
  | 'vol'
  | 'fees'
  | 'apr'
  | 'rewards'
  | 'actions'

const NUMERIC_KEYS = new Set<SortKey>(['tvl', 'vol', 'fees', 'apr'])

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
  const [sortKey, setSortKey] = useState<SortKey>('vol')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [addTarget, setAddTarget] = useState<AddTarget | null>(null)
  const [swapTarget, setSwapTarget] = useState<{
    tokenAddress: string
    tokenSymbol?: string
    pairLabel: string
  } | null>(null)

  const { rows, count, totals, ready, isLoading, isFetching, error, refetch } =
    useLpTerminalPools(true, {
      q: deferredQ,
      proto,
      hideDust,
      sort: 'vol',
      limit: 100,
    })

  const sortedRows = useMemo(() => {
    const list = [...rows]
    list.sort((a, b) => {
      switch (sortKey) {
        case 'pair':
          return compareStr(a.pair, b.pair, sortDir)
        case 'tvl':
          return compareNum(a.tvlUsd, b.tvlUsd, sortDir)
        case 'vol':
          return compareNum(a.vol24hUsd, b.vol24hUsd, sortDir)
        case 'fees':
          return compareNum(a.fees24hUsd, b.fees24hUsd, sortDir)
        case 'apr':
          return compareNum(a.feeAprPct, b.feeAprPct, sortDir)
        case 'rewards':
          return compareStr('—', '—', sortDir)
        case 'actions':
          return compareStr(actionsLabel(a), actionsLabel(b), sortDir)
        default:
          return 0
      }
    })
    return list
  }, [rows, sortKey, sortDir])

  const statusLine = useMemo(() => {
    const catalog = (totals.univ2 || 0) + (totals.univ3 || 0)
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
          {chip('univ3', 'UNI V3', proto === 'univ3')}
          {chip('univ2', 'UNI V2', proto === 'univ2')}
          {chip('dust', hideDust ? 'HIDE <$1K' : 'SHOW DUST', hideDust)}
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
          Add v1 = CLMM UniV3 · Add v2 = DAMM UniV2 zap · click Pair for GMGN
        </span>
      </p>

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading pools from LP Terminal indexer…</p>
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
                  label="Rewards"
                  col="rewards"
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
                          </div>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-200">
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
                      <td className="px-3 py-2.5 text-right text-gray-600">—</td>
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
                        <td colSpan={7} className="px-3 py-3">
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
