'use client'

import { useDeferredValue, useMemo, useState } from 'react'
import { useLpTerminalPools } from '@/hooks/useLpTerminalPools'
import RhUniv2LpSheet from '@/components/dlmm/RhUniv2LpSheet'
import { formatApr, formatUsd } from '@/utils/dlmm/format'
import { getLpTerminalPoolDeepLink } from '@/utils/dlmm/lp-terminal'
import {
  isRhUniv2QuotePool,
  quoteSymbolForAddress,
} from '@/utils/dlmm/rh-univ2'

type ProtoFilter = '' | 'univ3' | 'univ2'

function canInAppAdd(row: { proto: string; token0: string; token1: string }) {
  return isRhUniv2QuotePool(row)
}

export default function LpTerminalPoolsTable() {
  const [q, setQ] = useState('')
  const deferredQ = useDeferredValue(q)
  const [proto, setProto] = useState<ProtoFilter>('')
  const [hideDust, setHideDust] = useState(true)
  const [sort, setSort] = useState<'tvl' | 'vol' | 'created'>('vol')
  const [addPool, setAddPool] = useState<{
    address: string
    tokenAddress: string
    tokenSymbol?: string
  } | null>(null)

  const { rows, count, totals, ready, isLoading, isFetching, error, refetch } =
    useLpTerminalPools(true, {
      q: deferredQ,
      proto,
      hideDust,
      sort,
      limit: 100,
    })

  const statusLine = useMemo(() => {
    const catalog = (totals.univ2 || 0) + (totals.univ3 || 0)
    return `${rows.length} shown · uniswap catalog ${catalog.toLocaleString()}${
      count ? ` · ${count.toLocaleString()} match` : ''
    }${!ready ? ' · indexer warming…' : ''}`
  }, [rows.length, totals, count, ready])

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
      className={`shrink-0 px-2 py-1 text-[11px] font-mono uppercase tracking-wide border ${
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
          className="text-[11px] text-gray-400 hover:text-gray-200 px-2 py-1 border border-gray-700 disabled:opacity-50"
        >
          {isFetching ? '…' : '↻'}
        </button>
      </div>

      <p className="text-[11px] text-gray-500">{statusLine}</p>

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading pools from LP Terminal indexer…</p>
      ) : error ? (
        <p className="text-red-400 text-sm">
          {error instanceof Error ? error.message : 'Failed to load pools'}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-gray-500 text-sm">No pools matched filters.</p>
      ) : (
        <div className="overflow-x-auto border border-gray-800 bg-black">
          <table className="w-full text-left text-[11px] text-gray-300 min-w-[960px]">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <th className="px-3 py-2 font-normal">PAIR</th>
                <th className="px-3 py-2 font-normal">PRICE / RESERVES</th>
                <th className="px-3 py-2 font-normal text-right">
                  <button
                    type="button"
                    className={sort === 'tvl' ? 'text-emerald-400' : ''}
                    onClick={() => setSort('tvl')}
                  >
                    TVL{sort === 'tvl' ? ' ↓' : ''}
                  </button>
                </th>
                <th className="px-3 py-2 font-normal text-right">
                  <button
                    type="button"
                    className={sort === 'vol' ? 'text-emerald-400' : ''}
                    onClick={() => setSort('vol')}
                  >
                    VOL 24H{sort === 'vol' ? ' ↓' : ''}
                  </button>
                </th>
                <th className="px-3 py-2 font-normal text-right text-amber-500/90">
                  FEES 24H
                </th>
                <th className="px-3 py-2 font-normal text-right">FEE APR</th>
                <th className="px-3 py-2 font-normal text-right">REWARDS</th>
                <th className="px-3 py-2 font-normal text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.address}
                  className="border-b border-gray-900 hover:bg-gray-950/80"
                >
                  <td className="px-3 py-2.5">
                    <div className="text-white">{row.pair}</div>
                    <div className="text-gray-600">
                      {row.protoLabel.toLowerCase()} · {row.feeTier}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-400">{row.priceReserves}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
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
                    {canInAppAdd(row) ? (
                      <button
                        type="button"
                        onClick={() => {
                          const q0 = quoteSymbolForAddress(row.token0)
                          const q1 = quoteSymbolForAddress(row.token1)
                          const base = q0 ? row.token1 : row.token0
                          const parts = row.pair.split('/')
                          const baseSym = q0
                            ? parts[1]?.trim()
                            : parts[0]?.trim()
                          setAddPool({
                            address: row.address,
                            tokenAddress: base,
                            tokenSymbol: baseSym,
                          })
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 border border-emerald-700 text-emerald-300 hover:bg-emerald-950/50"
                      >
                        Add LP
                      </button>
                    ) : null}
                    <a
                      href={getLpTerminalPoolDeepLink(row.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2 py-1 border border-gray-700 text-gray-400 hover:text-gray-200"
                    >
                      Terminal ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {addPool ? (
        <RhUniv2LpSheet
          open
          onClose={() => setAddPool(null)}
          poolAddress={addPool.address}
          tokenAddress={addPool.tokenAddress}
          tokenSymbol={addPool.tokenSymbol}
        />
      ) : null}
    </div>
  )
}
