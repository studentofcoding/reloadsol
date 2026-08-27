'use client'

import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import { useQuery } from '@tanstack/react-query'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import { claimOwnerFees, type RhClmmCtx } from '@/utils/dlmm/rh-clmm'
import { RH_WETH } from '@/utils/dlmm/rh-univ2'
import { executeRhParentKyberSwap } from '@/utils/dlmm/rh-kyber-swap'
import { clientKyberRoute } from '@/utils/kyber-aggregator'
import { humanToFloat } from '@/utils/dlmm/rh-clmm/tokens'
import type { OnChainPosition } from '@/utils/dlmm/rh-clmm/positions'

type Mode = 'zap' | 'manual'

export type RhClmmClaimFeesSheetProps = {
  open: boolean
  onClose: () => void
  position: OnChainPosition
  onDone?: () => void
}

function sameAddr(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function defaultOutIs1(pos: OnChainPosition): boolean {
  if (sameAddr(pos.token1, RH_WETH)) return true
  if (sameAddr(pos.token0, RH_WETH)) return false
  return false
}

function fmtAmt(n: number) {
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n >= 1) return n.toFixed(6)
  return n.toPrecision(4)
}

export default function RhClmmClaimFeesSheet({
  open,
  onClose,
  position,
  onDone,
}: RhClmmClaimFeesSheetProps) {
  const wallet = useRhEvmWallet()
  const [mode, setMode] = useState<Mode>('zap')
  const [outIs1, setOutIs1] = useState(() => defaultOutIs1(position))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')

  const fee0 = useMemo(
    () => humanToFloat(position.tokensOwed0, position.decimals0),
    [position],
  )
  const fee1 = useMemo(
    () => humanToFloat(position.tokensOwed1, position.decimals1),
    [position],
  )
  const feesUsd = position.unclaimedFeesUsd
  const hasFees = position.tokensOwed0 > BigInt(0) || position.tokensOwed1 > BigInt(0)

  const tokenOut = outIs1 ? position.token1 : position.token0
  const symbolOut = outIs1 ? position.symbol1 : position.symbol0
  const tokenIn = outIs1 ? position.token0 : position.token1
  const symbolIn = outIs1 ? position.symbol0 : position.symbol1
  const feeOut = outIs1 ? fee1 : fee0
  const feeIn = outIs1 ? fee0 : fee1
  const amountInRaw = outIs1 ? position.tokensOwed0 : position.tokensOwed1
  const decimalsOut = outIs1 ? position.decimals1 : position.decimals0

  const zapQuote = useQuery({
    queryKey: [
      'clmm-claim-zap-quote',
      position.tokenId.toString(),
      tokenIn,
      tokenOut,
      amountInRaw.toString(),
    ],
    enabled: open && mode === 'zap' && amountInRaw > BigInt(0),
    staleTime: 12_000,
    queryFn: async () => {
      const route = await clientKyberRoute({
        tokenIn,
        tokenOut,
        amountIn: amountInRaw.toString(),
      })
      const outRaw = route.amountOut ? BigInt(route.amountOut) : BigInt(0)
      return {
        swappedOut: humanToFloat(outRaw, decimalsOut),
        amountOutRaw: outRaw,
      }
    },
  })

  const combinedOut =
    feeOut + (zapQuote.data?.swappedOut ?? (amountInRaw > BigInt(0) ? 0 : 0))
  // ponytail: USD for zap total ≈ listed unclaimedFeesUsd (no second price feed)
  const combinedUsd = feesUsd

  if (!open) return null

  async function ctx(): Promise<RhClmmCtx> {
    if (!wallet.address) throw new Error('Connect Rabby first')
    const walletClient = await wallet.getWalletClient()
    return {
      publicClient: wallet.getPublicClient(),
      walletClient,
      owner: wallet.address,
    }
  }

  async function runClaim() {
    setBusy(true)
    setError('')
    setOkMsg('')
    try {
      const c = await ctx()
      const claimed = await claimOwnerFees(
        c,
        position.tokenId,
        position.protocol,
      )

      if (mode === 'zap') {
        const swapInRaw = outIs1
          ? // claim returned humans; use listed raw for the non-out leg
            position.tokensOwed0
          : position.tokensOwed1
        // Prefer claim humans → raw via listed decimals when claim reported that leg
        const inHuman = outIs1 ? claimed.amount0Human : claimed.amount1Human
        const inDec = outIs1 ? position.decimals0 : position.decimals1
        let amountIn = swapInRaw
        if (inHuman > 0) {
          amountIn = BigInt(Math.floor(inHuman * 10 ** inDec))
        }
        if (amountIn > BigInt(0) && !sameAddr(tokenIn, tokenOut)) {
          const wc = await wallet.getWalletClient()
          await executeRhParentKyberSwap({
            publicClient: wallet.getPublicClient(),
            walletClient: wc,
            account: wallet.address as Address,
            tokenIn,
            tokenOut,
            amountIn: amountIn.toString(),
            slippageBps: 200,
          })
        }
        setOkMsg(
          `Claimed + zapped → ~${fmtAmt(combinedOut)} ${symbolOut} ($${combinedUsd.toFixed(2)})`,
        )
      } else {
        setOkMsg(
          `Claimed ${fmtAmt(claimed.amount0Human)} ${claimed.symbol0} + ${fmtAmt(claimed.amount1Human)} ${claimed.symbol1}`,
        )
      }
      onDone?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-white font-bold text-lg">Claim fees</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              #{position.tokenId.toString()} · {position.symbol0}/
              {position.symbol1} · {position.protocol}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-sm"
          >
            ✕
          </button>
        </div>

        <div className="flex gap-1.5">
          {(
            [
              ['zap', 'Zap out'],
              ['manual', 'Manual'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={`px-3 py-1.5 text-xs rounded border ${
                mode === id
                  ? 'border-emerald-500 bg-emerald-950/40 text-emerald-300'
                  : 'border-gray-700 text-gray-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="text-sm text-gray-300 space-y-1 border border-gray-800 rounded p-3 bg-black/40">
          <div>
            {fmtAmt(fee0)} {position.symbol0}
          </div>
          <div>
            {fmtAmt(fee1)} {position.symbol1}
          </div>
          <div className="text-amber-400/90 text-xs">
            ≈ ${feesUsd.toFixed(2)} unclaimed
          </div>
        </div>

        {mode === 'zap' ? (
          <div className="space-y-2">
            <div className="text-xs text-gray-400">Token out</div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setOutIs1(false)}
                className={`px-2.5 py-1 text-xs font-mono rounded border ${
                  !outIs1
                    ? 'border-sky-500 bg-sky-950/40 text-sky-300'
                    : 'border-gray-700 text-gray-400'
                }`}
              >
                {position.symbol0}
              </button>
              <button
                type="button"
                onClick={() => setOutIs1(true)}
                className={`px-2.5 py-1 text-xs font-mono rounded border ${
                  outIs1
                    ? 'border-sky-500 bg-sky-950/40 text-sky-300'
                    : 'border-gray-700 text-gray-400'
                }`}
              >
                {position.symbol1}
              </button>
            </div>
            <div className="text-[11px] text-gray-400 border border-gray-800 rounded p-2">
              {amountInRaw > BigInt(0) ? (
                zapQuote.isFetching ? (
                  <span>Quoting {symbolIn} → {symbolOut}…</span>
                ) : zapQuote.error ? (
                  <span className="text-red-400">
                    {zapQuote.error instanceof Error
                      ? zapQuote.error.message
                      : 'Quote failed'}
                  </span>
                ) : (
                  <span>
                    {fmtAmt(feeOut)} {symbolOut} + swap {fmtAmt(feeIn)}{' '}
                    {symbolIn} ≈{' '}
                    <span className="text-emerald-300">
                      {fmtAmt(combinedOut)} {symbolOut}
                    </span>{' '}
                    (~${combinedUsd.toFixed(2)})
                  </span>
                )
              ) : (
                <span>
                  All fees already in {symbolOut}: {fmtAmt(feeOut)}{' '}
                  {symbolOut} (~${combinedUsd.toFixed(2)})
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-600">
              Parent wallet: collect then Kyber-swap the other leg into{' '}
              {symbolOut}.
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-gray-500">
            Collect both fee tokens in-kind (position stays open).
          </p>
        )}

        {error ? (
          <p className="text-sm text-red-400 break-words">{error}</p>
        ) : null}
        {okMsg ? (
          <p className="text-sm text-emerald-400 break-words">{okMsg}</p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 border border-gray-700 text-gray-300 text-sm rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !hasFees || !wallet.address}
            onClick={() => void runClaim()}
            className="flex-1 py-2 bg-amber-700 hover:bg-amber-600 disabled:bg-gray-800 text-white text-sm rounded font-medium"
          >
            {busy ? '…' : 'Claim'}
          </button>
        </div>
      </div>
    </div>
  )
}
