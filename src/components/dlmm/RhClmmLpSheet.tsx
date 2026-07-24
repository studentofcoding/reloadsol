'use client'

import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import { useCreateRhClmmMark } from '@/hooks/useRhClmmPositions'
import {
  mintPool,
  previewMintPool,
  type RhClmmCtx,
} from '@/utils/dlmm/rh-clmm'
import {
  DEFAULT_BALANCE_PERCENT,
  DEFAULT_WIDTH_PERCENT,
} from '@/utils/dlmm/rh-clmm/config'

export type RhClmmLpSheetProps = {
  open: boolean
  onClose: () => void
  /** Univ3 pool contract address from LP Terminal */
  poolAddress: string
  pairLabel?: string
  tokenAddress?: string
  tokenSymbol?: string
}

export default function RhClmmLpSheet({
  open,
  onClose,
  poolAddress,
  pairLabel,
  tokenAddress,
  tokenSymbol,
}: RhClmmLpSheetProps) {
  const wallet = useRhEvmWallet()
  const createMark = useCreateRhClmmMark()
  const [preview, setPreview] = useState<string | null>(null)
  const [meta, setMeta] = useState<{
    symbol0: string
    symbol1: string
    fee: number
    depositToken: Address
  } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [txLink, setTxLink] = useState<string | null>(null)

  async function ctx(): Promise<RhClmmCtx> {
    if (!wallet.address) throw new Error('Connect Rabby first')
    await wallet.ensureChain()
    const walletClient = await wallet.getWalletClient()
    const owner = (walletClient.account?.address ?? wallet.address) as Address
    return {
      publicClient: wallet.publicClient,
      walletClient,
      owner,
    }
  }

  useEffect(() => {
    if (!open || !poolAddress) return
    let cancelled = false
    setPreview(null)
    setMeta(null)
    setError(null)
    setTxLink(null)
    setBusy('preview')
    ;(async () => {
      try {
        if (!wallet.address) {
          // Wait for connect — still show pool id
          if (!cancelled) setBusy(null)
          return
        }
        const c = await ctx()
        const r = await previewMintPool(poolAddress as Address, c)
        if (cancelled) return
        setPreview(r.text)
        setMeta({
          symbol0: r.symbol0,
          symbol1: r.symbol1,
          fee: r.fee,
          depositToken: r.depositToken,
        })
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Preview failed')
        }
      } finally {
        if (!cancelled) setBusy(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, poolAddress, wallet.address])

  async function runPreview() {
    setError(null)
    setBusy('preview')
    try {
      if (!wallet.address) await wallet.connect()
      const c = await ctx()
      const r = await previewMintPool(poolAddress as Address, c)
      setPreview(r.text)
      setMeta({
        symbol0: r.symbol0,
        symbol1: r.symbol1,
        fee: r.fee,
        depositToken: r.depositToken,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setBusy(null)
    }
  }

  async function runMint() {
    setError(null)
    setBusy('mint')
    try {
      if (!wallet.address) await wallet.connect()
      const c = await ctx()
      const result = await mintPool(poolAddress as Address, c)
      await createMark.mutateAsync({
        token_id: result.tokenId.toString(),
        protocol: 'v3',
        pool_address: String(result.poolAddress),
        pair_label:
          pairLabel ||
          (meta ? `${meta.symbol0}/${meta.symbol1}` : null),
        token_address: tokenAddress ?? null,
        deposit_symbol: tokenSymbol ?? null,
        owner_address: c.owner,
        entry_value_usd: 0,
        mint_tx: result.hash,
      })
      setTxLink(result.txLink)
      setPreview(`Minted #${result.tokenId} (v3)\n${result.txLink}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      setBusy(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-white font-bold text-lg">Add CLMM v1 (UniV3)</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {pairLabel || meta
                ? `${pairLabel || `${meta?.symbol0}/${meta?.symbol1}`} · single-sided · width ${DEFAULT_WIDTH_PERCENT}% · ${DEFAULT_BALANCE_PERCENT}% bal`
                : 'Loading pool…'}
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

        <div className="text-[11px] text-gray-500 font-mono break-all">
          Pool {poolAddress}
          {meta ? ` · fee ${(meta.fee / 10000).toFixed(2)}%` : ''}
        </div>

        {preview ? (
          <pre className="text-xs text-gray-300 bg-black/40 border border-gray-700 rounded p-3 whitespace-pre-wrap overflow-x-auto max-h-48">
            {preview}
          </pre>
        ) : (
          <p className="text-xs text-gray-500">
            {busy === 'preview'
              ? 'Building mint preview…'
              : 'Connect Rabby and preview to see range / deposit.'}
          </p>
        )}

        {error ? (
          <p className="text-sm text-red-400 break-words">{error}</p>
        ) : null}
        {txLink ? (
          <a
            href={txLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline break-all"
          >
            View tx
          </a>
        ) : null}

        <div className="flex flex-col gap-2">
          {!wallet.address ? (
            <button
              type="button"
              onClick={() => void wallet.connect()}
              disabled={wallet.connecting || !wallet.hasProvider}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-sm rounded"
            >
              {!wallet.hasProvider
                ? 'No Rabby (or EVM wallet)'
                : wallet.connecting
                  ? 'Connecting…'
                  : 'Connect Rabby'}
            </button>
          ) : (
            <p className="text-xs text-gray-400 font-mono">
              {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
              {!wallet.isCorrectChain ? ' · switch to RH (4663)' : ''}
            </p>
          )}

          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={!!busy}
            className="w-full py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-sm rounded"
          >
            {busy === 'preview' ? '…' : 'Refresh preview'}
          </button>
          <button
            type="button"
            onClick={() => void runMint()}
            disabled={!!busy || !wallet.address}
            className="w-full py-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 text-white text-sm rounded font-medium"
          >
            {busy === 'mint' ? 'Minting…' : 'Confirm mint'}
          </button>
        </div>
      </div>
    </div>
  )
}
