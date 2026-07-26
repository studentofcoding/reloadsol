'use client'

import { Fragment, useDeferredValue, useMemo, useState } from 'react'
import type { DisplayCandidate } from '@/components/dlmm/HunterCandidateTabs'
import type { EnrichedPool } from '@/hooks/useDlmmPools'
import GmgnChartEmbed from '@/components/signals/shared/GmgnChartEmbed'
import { formatApr, formatUsd } from '@/utils/dlmm/format'
import { getPoolChartMint } from '@/utils/gmgn'
import {
  compareNum,
  compareStr,
  sortMarker,
  toggleSort,
  type SortDir,
} from '@/utils/dlmm/table-sort'

type SortKey =
  | 'pair'
  | 'tvl'
  | 'vol'
  | 'fees'
  | 'apr'
  | 'rewards'
  | 'actions'

const NUMERIC_KEYS = new Set<SortKey>(['tvl', 'vol', 'fees', 'apr'])

type Row = {
  key: string
  pair: string
  feeTier: string
  priceReserves: string
  tvl: number
  vol24h: number | null
  fees24h: number | null
  feeAprPct: number | null
  rewards: string
  actionsLabel: string
  chartMint: string | null
  candidate: DisplayCandidate
  matchedPool: EnrichedPool | undefined
}

function buildRows(
  candidates: DisplayCandidate[],
  pools: EnrichedPool[],
): Row[] {
  return candidates.map((c) => {
    const matched = pools.find((p) => p.address === c.pool_address)
    const volRaw = matched?.volume?.['24h']
    const vol =
      typeof volRaw === 'number' && Number.isFinite(volRaw) ? volRaw : null
    const feesDirect = matched?.fees?.['24h']
    const feeRatio = c.fee_tvl_ratio_24h || matched?.fee_tvl_ratio_24h || 0
    const fees24h =
      typeof feesDirect === 'number' && Number.isFinite(feesDirect)
        ? feesDirect
        : feeRatio > 0 && c.tvl > 0
          ? c.tvl * feeRatio
          : null
    // ponytail: fee_tvl_ratio_24h treated as daily fee/TVL fraction → APR %
    const feeAprPct =
      typeof matched?.apr === 'number' && Number.isFinite(matched.apr)
        ? matched.apr
        : typeof matched?.apy === 'number' && Number.isFinite(matched.apy)
          ? matched.apy
          : feeRatio > 0
            ? feeRatio * 365 * 100
            : null

    const bin = matched?.pool_config?.bin_step
    const baseFee = matched?.pool_config?.base_fee_pct
    const feeTierParts: string[] = ['dlmm']
    if (bin != null) feeTierParts.push(`bin ${bin}`)
    if (baseFee != null) feeTierParts.push(`${baseFee}% fee`)

    const price =
      matched && Number.isFinite(matched.current_price) && matched.current_price > 0
        ? matched.current_price.toPrecision(5)
        : '—'

    return {
      key: c.pool_address,
      pair: `${c.token_x_symbol}/${c.token_y_symbol}`,
      feeTier: feeTierParts.join(' · '),
      priceReserves: price,
      tvl: c.tvl,
      vol24h: vol,
      fees24h,
      feeAprPct,
      rewards:
        c.organic_score > 0 ? `org ${c.organic_score.toFixed(1)}` : '—',
      actionsLabel: matched ? 'Deploy' : '—',
      chartMint: getPoolChartMint(c.token_x_address, c.token_y_address),
      candidate: c,
      matchedPool: matched,
    }
  })
}

function SortTh({
  label,
  col,
  sortKey,
  sortDir,
  align = 'left',
  className = '',
  onSort,
}: {
  label: string
  col: SortKey
  sortKey: SortKey
  sortDir: SortDir
  align?: 'left' | 'right'
  className?: string
  onSort: (col: SortKey) => void
}) {
  const active = sortKey === col
  return (
    <th
      className={`px-3 py-2 font-normal ${align === 'right' ? 'text-right' : ''} ${className}`}
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

export default function DlmmGeneralPoolsTable({
  candidates,
  pools,
  dbReady,
  onDeploy,
}: {
  candidates: DisplayCandidate[]
  pools: EnrichedPool[]
  dbReady: boolean
  onDeploy: (pool: EnrichedPool) => void
}) {
  const [q, setQ] = useState('')
  const deferredQ = useDeferredValue(q)
  const [sortKey, setSortKey] = useState<SortKey>('tvl')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const rows = useMemo(() => buildRows(candidates, pools), [candidates, pools])

  const filtered = useMemo(() => {
    const needle = deferredQ.trim().toLowerCase()
    let list = rows
    if (needle) {
      list = list.filter((r) => {
        const c = r.candidate
        return (
          r.pair.toLowerCase().includes(needle) ||
          c.pool_name.toLowerCase().includes(needle) ||
          c.pool_address.toLowerCase().includes(needle) ||
          (c.token_x_address?.toLowerCase().includes(needle) ?? false) ||
          (c.token_y_address?.toLowerCase().includes(needle) ?? false)
        )
      })
    }
    const sorted = [...list]
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'pair':
          return compareStr(a.pair, b.pair, sortDir)
        case 'tvl':
          return compareNum(a.tvl, b.tvl, sortDir)
        case 'vol':
          return compareNum(a.vol24h, b.vol24h, sortDir)
        case 'fees':
          return compareNum(a.fees24h, b.fees24h, sortDir)
        case 'apr':
          return compareNum(a.feeAprPct, b.feeAprPct, sortDir)
        case 'rewards':
          return compareStr(a.rewards, b.rewards, sortDir)
        case 'actions':
          return compareStr(a.actionsLabel, b.actionsLabel, sortDir)
        default:
          return 0
      }
    })
    return sorted
  }, [rows, deferredQ, sortKey, sortDir])

  const onSort = (col: SortKey) => {
    const next = toggleSort(sortKey, sortDir, col, {
      numericFirstDesc: NUMERIC_KEYS.has(col),
    })
    setSortKey(next.key)
    setSortDir(next.dir)
  }

  return (
    <div className="space-y-3 font-mono">
      <div className="flex flex-col lg:flex-row gap-2 lg:items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="pair / pool name / address"
          className="flex-1 bg-black border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded-none focus:outline-none focus:border-emerald-600"
        />
      </div>

      <p className="text-[11px] text-gray-500">
        {filtered.length} shown · hunter screen · click Pair for GMGN chart
      </p>

      {filtered.length === 0 ? (
        <p className="text-gray-500 text-sm">No pools matched filters.</p>
      ) : (
        <div className="overflow-x-auto border border-gray-800 bg-black">
          <table className="w-full text-left text-[11px] text-gray-300 min-w-[960px]">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <SortTh
                  label="Pair"
                  col="pair"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <th className="px-3 py-2 font-normal">PRICE / RESERVES</th>
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
                  className="text-amber-500/90"
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
              {filtered.map((row) => {
                const open = expandedKey === row.key
                return (
                  <Fragment key={row.key}>
                    <tr className="border-b border-gray-900 hover:bg-gray-950/80">
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedKey(open ? null : row.key)
                          }
                          className="text-left w-full hover:opacity-90"
                          title={
                            row.chartMint
                              ? 'Toggle GMGN chart'
                              : 'No chartable token'
                          }
                          disabled={!row.chartMint}
                        >
                          <div className="text-white">
                            {row.pair}
                            {open ? ' ▾' : ' ▸'}
                          </div>
                          <div className="text-gray-600">{row.feeTier}</div>
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-gray-400">
                        {row.priceReserves}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {formatUsd(row.tvl)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {row.vol24h != null ? formatUsd(row.vol24h) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-amber-400/90">
                        {row.fees24h != null ? formatUsd(row.fees24h) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {formatApr(row.feeAprPct)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-gray-500">
                        {row.rewards}
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <button
                          type="button"
                          disabled={!dbReady || !row.matchedPool}
                          title={
                            row.matchedPool
                              ? 'Deploy LP position'
                              : 'No Meteora pool loaded yet'
                          }
                          onClick={() => {
                            if (row.matchedPool) onDeploy(row.matchedPool)
                          }}
                          className="inline-flex items-center gap-1 px-2 py-1 border border-green-700 text-green-300 hover:bg-green-950/50 disabled:border-gray-700 disabled:text-gray-600 disabled:cursor-not-allowed"
                        >
                          Deploy
                        </button>
                      </td>
                    </tr>
                    {open && row.chartMint ? (
                      <tr className="border-b border-gray-900 bg-gray-950/40">
                        <td colSpan={8} className="px-3 py-3">
                          <div className="relative h-[280px] w-full">
                            <GmgnChartEmbed
                              tokenAddress={row.chartMint}
                              chain="sol"
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
    </div>
  )
}
