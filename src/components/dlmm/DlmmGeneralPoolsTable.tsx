'use client'

import { useDeferredValue, useMemo, useState } from 'react'
import type { DisplayCandidate } from '@/components/dlmm/HunterCandidateTabs'
import type { EnrichedPool } from '@/hooks/useDlmmPools'
import { formatApr, formatUsd } from '@/utils/dlmm/format'

type SortKey = 'tvl' | 'apr' | 'score'

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
  score: number
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
      score: c.score,
      candidate: c,
      matchedPool: matched,
    }
  })
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
  const [sort, setSort] = useState<SortKey>('score')

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
      if (sort === 'tvl') return b.tvl - a.tvl
      if (sort === 'apr') return (b.feeAprPct ?? -1) - (a.feeAprPct ?? -1)
      return b.score - a.score
    })
    return sorted
  }, [rows, deferredQ, sort])

  return (
    <div className="space-y-3 font-mono">
      <div className="flex flex-col lg:flex-row gap-2 lg:items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="pair / pool name / address"
          className="flex-1 bg-black border border-gray-700 text-gray-200 text-xs px-3 py-2 rounded-none focus:outline-none focus:border-emerald-600"
        />
        <div className="flex flex-wrap gap-1.5 text-[11px] text-gray-500">
          <span className="px-2 py-1 border border-gray-800">sort:</span>
          {(
            [
              ['score', 'SCORE'],
              ['tvl', 'TVL'],
              ['apr', 'FEE APR'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className={`px-2 py-1 border uppercase tracking-wide ${
                sort === key
                  ? 'border-emerald-500 text-emerald-300 bg-emerald-950/40'
                  : 'border-gray-700 text-gray-400 hover:border-gray-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-gray-500">
        {filtered.length} shown · hunter screen
      </p>

      {filtered.length === 0 ? (
        <p className="text-gray-500 text-sm">No pools matched filters.</p>
      ) : (
        <div className="overflow-x-auto border border-gray-800 bg-black">
          <table className="w-full text-left text-[11px] text-gray-300 min-w-[960px]">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <th className="px-3 py-2 font-normal">PAIR</th>
                <th className="px-3 py-2 font-normal">PRICE / RESERVES</th>
                <th className="px-3 py-2 font-normal text-right">TVL</th>
                <th className="px-3 py-2 font-normal text-right">VOL 24H</th>
                <th className="px-3 py-2 font-normal text-right text-amber-500/90">
                  FEES 24H
                </th>
                <th className="px-3 py-2 font-normal text-right">FEE APR</th>
                <th className="px-3 py-2 font-normal text-right">REWARDS</th>
                <th className="px-3 py-2 font-normal text-right" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-gray-900 hover:bg-gray-950/80"
                >
                  <td className="px-3 py-2.5">
                    <div className="text-white">{row.pair}</div>
                    <div className="text-gray-600">{row.feeTier}</div>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
