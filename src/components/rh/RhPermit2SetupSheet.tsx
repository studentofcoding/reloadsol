'use client'

import { useState } from 'react'
import type { Address, PublicClient, WalletClient } from 'viem'
import { executeRhWalletCalls } from '@/utils/dlmm/rh-send-calls'
import {
  isPermit2Ready,
  planPermit2SetupCalls,
  type Permit2TokenReadiness,
} from '@/utils/dlmm/rh-permit2-readiness'

type SetupToken = {
  address: Address
  symbol?: string
}

export function RhPermit2StatusBanner(props: {
  executorConfigured: boolean
  readiness: readonly Permit2TokenReadiness[] | undefined
  loading?: boolean
  error?: boolean
  onSetup: () => void
}) {
  if (!props.executorConfigured) {
    return (
      <div className="rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
        BatchExecutor is unavailable. Robinhood parent trades use the legacy
        wallet path and may require sequential approvals and signatures.
      </div>
    )
  }
  const total = props.readiness?.length ?? 0
  const ready =
    props.readiness?.filter((item) => item.status === 'ready').length ?? 0
  const allReady = props.readiness != null && isPermit2Ready(props.readiness)

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${
        allReady
          ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-200'
          : 'border-amber-700/60 bg-amber-950/30 text-amber-200'
      }`}
    >
      <span>
        {props.loading
          ? 'Checking one-click trade setup…'
          : props.error
            ? 'Could not check one-click trade setup.'
            : allReady
              ? 'One-click trade ready · each trade uses one wallet confirmation.'
              : `${ready}/${total} tokens ready · approve once before trading.`}
      </span>
      {!allReady ? (
        <button
          type="button"
          onClick={props.onSetup}
          className="shrink-0 rounded bg-amber-700 px-2.5 py-1 font-semibold text-white hover:bg-amber-600"
        >
          Set up
        </button>
      ) : null}
    </div>
  )
}

export default function RhPermit2SetupSheet(props: {
  open: boolean
  onClose: () => void
  publicClient: PublicClient
  getWalletClient: () => WalletClient | Promise<WalletClient>
  account: Address
  spender: Address | null
  tokens: readonly SetupToken[]
  readiness: readonly Permit2TokenReadiness[] | undefined
  loading?: boolean
  error?: boolean
  onRefresh: () => Promise<readonly Permit2TokenReadiness[] | undefined>
  onReady?: () => void
}) {
  const [approving, setApproving] = useState(false)
  const [submitError, setSubmitError] = useState('')
  if (!props.open) return null

  const labels = new Map(
    props.tokens.map((token) => [token.address.toLowerCase(), token.symbol]),
  )
  const allReady =
    props.readiness != null && isPermit2Ready(props.readiness)

  const approve = async () => {
    if (!props.spender || !props.readiness) return
    setApproving(true)
    setSubmitError('')
    try {
      const calls = planPermit2SetupCalls({
        readiness: props.readiness,
        spender: props.spender,
      })
      if (calls.length > 0) {
        await executeRhWalletCalls({
          publicClient: props.publicClient,
          walletClient: await props.getWalletClient(),
          account: props.account,
          calls,
        })
      }
      const refreshed = await props.onRefresh()
      if (refreshed && isPermit2Ready(refreshed)) {
        props.onReady?.()
        props.onClose()
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setApproving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Set up one-click Robinhood trades"
        className="w-full max-w-lg space-y-4 rounded-t-2xl border border-gray-700 bg-gray-900 p-5 shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-white">
              Set up one-click trades
            </h3>
            <p className="mt-1 text-sm text-gray-400">
              This does not move funds. It lets BatchExecutor pull only the
              tokens used by a trade. You still confirm every trade.
            </p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            disabled={approving}
            className="text-gray-400 hover:text-white disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        {!props.spender ? (
          <div className="rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-sm text-amber-200">
            BatchExecutor is not configured. Trades use the legacy path and
            may require sequential approval and swap confirmations.
          </div>
        ) : props.loading ? (
          <p className="text-sm text-gray-400">Checking allowances…</p>
        ) : props.error ? (
          <p className="text-sm text-red-400">
            Allowances could not be checked. Close and try again.
          </p>
        ) : props.readiness?.length ? (
          <div className="divide-y divide-gray-800 rounded-lg border border-gray-700">
            {props.readiness.map((item) => {
              const symbol = labels.get(item.token.toLowerCase())
              return (
                <div
                  key={item.token.toLowerCase()}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">
                      {symbol || item.token}
                    </p>
                    {symbol ? (
                      <p className="truncate font-mono text-[10px] text-gray-500">
                        {item.token}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 text-xs font-semibold ${
                      item.status === 'ready'
                        ? 'text-emerald-400'
                        : 'text-amber-300'
                    }`}
                  >
                    {item.status === 'ready' ? 'Ready' : 'Needs approval'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-emerald-300">
            Native ETH needs no Permit2 approval.
          </p>
        )}

        {submitError ? <p className="text-sm text-red-400">{submitError}</p> : null}

        <button
          type="button"
          onClick={() => void approve()}
          disabled={
            !props.spender ||
            props.loading ||
            props.error ||
            !props.readiness ||
            approving ||
            allReady
          }
          className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-gray-700"
        >
          {approving ? 'Approving…' : allReady ? 'Ready' : 'Approve once'}
        </button>
      </div>
    </div>
  )
}
