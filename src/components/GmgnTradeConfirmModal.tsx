'use client'

import React from 'react'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { RH_CHAIN_ID, txUrl } from '@/utils/dlmm/rh-clmm/config'

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

export type SubmitPhase = 'idle' | 'submitting' | 'success' | 'failed'

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
  submitPhase,
  resultMessage,
  txHash,
  onCancel,
  onConfirm,
  onDone,
}: {
  open: boolean
  chain: GmgnTradeChain
  from: string
  legs: GmgnConfirmLeg[]
  busy?: boolean
  /** Parent Rabby: wallet may ask once per Approve / Swap (no EIP-5792 atomic). */
  sequentialSignHint?: boolean
  /**
   * On-chain settlement phase. Defaults from `busy` when omitted so existing
   * callers keep the legacy "Submitting…" button. When provided, the modal
   * renders a spinner while submitting and an explicit success/failed screen
   * once the tx resolves.
   */
  submitPhase?: SubmitPhase
  /** Failure reason (shown on the failed result screen). */
  resultMessage?: string
  /** Confirmed tx hash (shown as an explorer link on the success screen). */
  txHash?: string
  onCancel: () => void
  onConfirm: () => void
  /** Closes the result screen (success/failed). */
  onDone?: () => void
}) {
  if (!open) return null
  const phase: SubmitPhase = submitPhase ?? (busy ? 'submitting' : 'idle')
  const isSubmitting = phase === 'submitting'
  const title =
    chain === 'robinhood' ? 'Confirm RH trade' : `Confirm GMGN ${chain} trade`

  // Result screen with the tx explorer link.
  const explorerUrl =
    phase === 'success' || phase === 'failed'
      ? chain === 'robinhood'
        ? txHash
          ? txUrl(RH_CHAIN_ID, txHash)
          : null
        : txHash
          ? `https://solscan.io/tx/${txHash}`
          : null
      : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gmgn-confirm-title"
        className={`w-full max-w-md rounded-2xl border bg-gray-900 p-6 shadow-xl ${
          phase === 'success'
            ? 'border-emerald-600'
            : phase === 'failed'
              ? 'border-red-600'
              : 'border-gray-600'
        }`}
      >
        {phase === 'success' ? (
          <div className="text-center py-6">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600/20 text-2xl text-emerald-400">
              ✓
            </div>
            <h3 id="gmgn-confirm-title" className="text-lg font-semibold text-white">
              Swap confirmed
            </h3>
            <p className="mt-1 text-xs text-gray-400">
              The transaction settled on-chain.
            </p>
            {txHash ? (
              <a
                href={explorerUrl ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block rounded-lg bg-emerald-600/20 px-3 py-1.5 font-mono text-xs text-emerald-300 hover:bg-emerald-600/30"
              >
                View transaction ↗
              </a>
            ) : null}
            {onDone ? (
              <button
                type="button"
                onClick={onDone}
                className="mt-5 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
              >
                Done
              </button>
            ) : null}
          </div>
        ) : phase === 'failed' ? (
          <div className="text-center py-6">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-600/20 text-2xl text-red-400">
              ✕
            </div>
            <h3 id="gmgn-confirm-title" className="text-lg font-semibold text-white">
              Swap failed
            </h3>
            {resultMessage ? (
              <p className="mt-2 break-words text-sm text-red-300">
                {resultMessage}
              </p>
            ) : (
              <p className="mt-2 text-sm text-gray-400">
                The transaction could not be confirmed on-chain.
              </p>
            )}
            {onDone ? (
              <button
                type="button"
                onClick={onDone}
                className="mt-5 rounded-lg bg-white px-5 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-200"
              >
                Done
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <h3
              id="gmgn-confirm-title"
              className="text-lg font-semibold text-white"
            >
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

            {isSubmitting ? (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2 text-sm text-gray-300">
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                Submitting &amp; confirming on-chain…
              </div>
            ) : null}

            <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto text-sm text-gray-200">
              {legs.map((leg) => (
                <li
                  key={leg.tokenAddress}
                  className="rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2"
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">
                      {leg.side === 'buy' ? 'Buy' : 'Sell'}{' '}
                      {leg.symbol || 'token'}
                    </span>
                    <span className="font-mono text-gray-300">
                      {leg.amountLabel}
                    </span>
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
                disabled={isSubmitting}
                className="rounded-lg px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={isSubmitting}
                className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-200 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <span className="flex items-center gap-2">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-900/30 border-t-gray-900" />
                    Submitting…
                  </span>
                ) : (
                  'Confirm & submit'
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}