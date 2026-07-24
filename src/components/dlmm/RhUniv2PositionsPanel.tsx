'use client'

import { useState } from 'react'
import type { RhUniv2Position } from '@/types/dlmm'
import {
  usePatchRhUniv2Position,
  useRhUniv2Positions,
} from '@/hooks/useRhUniv2Positions'
import RhUniv2LpSheet from '@/components/dlmm/RhUniv2LpSheet'
import { explorerTxUrl } from '@/utils/dlmm/rh-univ2'

function formatPct(n: number) {
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}%`
}

function formatUsd(n: number) {
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

export default function RhUniv2PositionsPanel() {
  const { data, isLoading, refetch, isFetching } = useRhUniv2Positions('open')
  const patch = usePatchRhUniv2Position()
  const [closePos, setClosePos] = useState<RhUniv2Position | null>(null)
  const positions = data?.positions ?? []

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h2 className="text-xl font-bold text-white">
          DAMM v2 / UniV2 ({positions.length})
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={patch.isPending || isFetching}
            onClick={() =>
              void patch.mutateAsync({ action: 'refresh_all' }).then(() =>
                refetch(),
              )
            }
            className="px-3 py-1 text-xs border border-gray-600 text-gray-300 hover:border-emerald-600 rounded"
          >
            Refresh marks
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Constant-product (UniV2) LP on Robinhood — marks in DB; close signs with
        Rabby on chain 4663 (ArrowRPC).
      </p>
      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : positions.length === 0 ? (
        <p className="text-gray-500 text-sm">No open RH V2 positions.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <th className="py-2 pr-4">Pair</th>
                <th className="py-2 pr-4">Quote</th>
                <th className="py-2 pr-4">Entry</th>
                <th className="py-2 pr-4">Mark</th>
                <th className="py-2 pr-4">PnL</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-gray-800 text-white"
                >
                  <td className="py-3 pr-4">
                    <div>{p.pair_label || p.pool_address.slice(0, 10)}</div>
                    <div className="text-[10px] text-gray-500 font-mono">
                      {p.owner_address.slice(0, 6)}…{p.owner_address.slice(-4)}
                    </div>
                  </td>
                  <td className="py-3 pr-4">{p.quote_symbol}</td>
                  <td className="py-3 pr-4">
                    {p.entry_quote_amount} → {formatUsd(p.entry_value_usd)}
                  </td>
                  <td className="py-3 pr-4">{formatUsd(p.current_value_usd)}</td>
                  <td
                    className={`py-3 pr-4 ${
                      p.pnl_pct >= 0 ? 'text-green-400' : 'text-red-400'
                    }`}
                  >
                    {formatPct(p.pnl_pct)}
                  </td>
                  <td className="py-3 flex flex-wrap gap-2">
                    {p.add_tx && (
                      <a
                        href={explorerTxUrl(p.add_tx)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2 py-1 text-xs text-blue-400 hover:underline"
                      >
                        Add tx
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => setClosePos(p)}
                      className="px-2 py-1 bg-red-600 hover:bg-red-700 rounded text-xs"
                    >
                      Close
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {closePos ? (
        <RhUniv2LpSheet
          open
          onClose={() => setClosePos(null)}
          closePosition={closePos}
        />
      ) : null}
    </section>
  )
}
