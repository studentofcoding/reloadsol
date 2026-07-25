'use client'

import React from 'react'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'

export type GmgnConfirmLeg = {
  tokenAddress: string
  symbol?: string
  amountLabel: string
  estOut?: string
  side: 'buy' | 'sell'
  fromUsd?: number | null
  toUsd?: number | null
  priceImpactPct?: number | null
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return `$${n.toFixed(0)}`
  if (Math.abs(n) >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(4)}`
}

function fmtImpact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n.toFixed(2)}%`
}

export default function GmgnTradeConfirmModal({
  open,
  chain,
  from,
  legs,
  busy,
  sequentialSignHint,
  onCancel,
  onConfirm,
}: {
  open: boolean
  chain: GmgnTradeChain
  from: string
  legs: GmgnConfirmLeg[]
  busy?: boolean
  /** Parent Rabby: wallet may ask once per Approve / Swap (no EIP-5792 atomic). */
  sequentialSignHint?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!open) return null
  const title =
    chain === 'robinhood' ? 'Confirm RH trade' : `Confirm GMGN ${chain} trade`
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gmgn-confirm-title"
        className="w-full max-w-md rounded-2xl border border-gray-600 bg-gray-900 p-6 shadow-xl"
      >
        <h3 id="gmgn-confirm-title" className="text-lg font-semibold text-white">
          {title}
        </h3>
        <p className="mt-1 text-xs text-gray-400 break-all">From: {from}</p>
        {sequentialSignHint ? (
          <p className="mt-2 text-xs text-amber-200/90">
            Kyber via Rabby: one wallet confirmation when batching is
            supported; otherwise Approve then Swap (two prompts, one app
            click).
          </p>
        ) : null}
        <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto text-sm text-gray-200">
          {legs.map((leg) => (
            <li
              key={leg.tokenAddress}
              className="rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2"
            >
              <div className="flex justify-between gap-2">
                <span className="font-medium">
                  {leg.side === 'buy' ? 'Buy' : 'Sell'} {leg.symbol || 'token'}
                </span>
                <span className="font-mono text-gray-300">{leg.amountLabel}</span>
              </div>
              <div className="mt-1 text-xs text-emerald-300/90 font-mono">
                {fmtUsd(leg.fromUsd)} → {fmtUsd(leg.toUsd)}
                {' · '}
                impact {fmtImpact(leg.priceImpactPct)}
              </div>
              {leg.estOut ? (
                <div className="mt-1 text-xs text-gray-400">
                  Est. out (raw): {leg.estOut}
                </div>
              ) : null}
              <div className="mt-1 truncate font-mono text-[10px] text-gray-500">
                {leg.tokenAddress}
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-200 disabled:opacity-50"
          >
            {busy ? 'Submitting…' : 'Confirm & submit'}
          </button>
        </div>
      </div>
    </div>
  )
}
