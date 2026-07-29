'use client'

import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import { useCreateRhClmmMark } from '@/hooks/useRhClmmPositions'
import GmgnChartEmbed from '@/components/signals/shared/GmgnChartEmbed'
import {
  mintPool,
  previewMintPool,
  type RhClmmCtx,
} from '@/utils/dlmm/rh-clmm'
import {
  DEFAULT_BALANCE_PERCENT,
  DEFAULT_WIDTH_PERCENT,
} from '@/utils/dlmm/rh-clmm/config'
import { resolvePoolMintProtocol } from '@/utils/dlmm/rh-clmm-pool-protocol'

export type RhClmmLpSheetProps = {
  open: boolean
  onClose: () => void
  poolAddress: string
  /** LP Terminal proto: univ3 | univ4 (or v3 | v4) */
  proto?: string
  pairLabel?: string
  tokenAddress?: string
  tokenSymbol?: string
}

type Mode = 'single' | 'dual'

type PreviewMeta = {
  symbol0: string
  symbol1: string
  fee: number
  depositToken: Address
}

function RhClmmLpSheetBody({
  poolAddress,
  proto,
  pairLabel,
  tokenAddress,
  tokenSymbol,
  onClose,
}: Omit<RhClmmLpSheetProps, 'open'>) {
  const wallet = useRhEvmWallet()
  const createMark = useCreateRhClmmMark()
  const mintProtocol = resolvePoolMintProtocol(poolAddress, proto)
  const [mode, setMode] = useState<Mode>('single')
  const [widthPercent, setWidthPercent] = useState(DEFAULT_WIDTH_PERCENT)
  const [minPct, setMinPct] = useState(-10)
  const [maxPct, setMaxPct] = useState(10)
  const [fullRange, setFullRange] = useState(false)
  const [balancePercent, setBalancePercent] = useState(DEFAULT_BALANCE_PERCENT)
  const [mintBusy, setMintBusy] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  const [txLink, setTxLink] = useState<string | null>(null)
  const [mintedText, setMintedText] = useState<string | null>(null)

  const buildCtx = useCallback(async (): Promise<RhClmmCtx> => {
    if (!wallet.address) throw new Error('Connect Rabby first')
    await wallet.ensureChain()
    const walletClient = await wallet.getWalletClient()
    const owner = (walletClient.account?.address ?? wallet.address) as Address
    return {
      publicClient: wallet.publicClient,
      walletClient,
      owner,
    }
  }, [wallet])

  const mintOpts =
    mode === 'dual'
      ? {
          mode: 'dual' as const,
          minPct,
          maxPct,
          fullRange,
          balancePercent,
          protocol: proto,
        }
      : {
          mode: 'single' as const,
          widthPercent,
          balancePercent,
          protocol: proto,
        }

  const previewQuery = useQuery({
    queryKey: [
      'rh-clmm-lp-preview',
      poolAddress,
      proto,
      wallet.address,
      mode,
      widthPercent,
      minPct,
      maxPct,
      fullRange,
      balancePercent,
    ],
    enabled: Boolean(wallet.address && poolAddress),
    staleTime: 15_000,
    queryFn: async () => {
      const c = await buildCtx()
      return previewMintPool(poolAddress as Address, c, mintOpts)
    },
  })

  const preview = mintedText ?? previewQuery.data?.text ?? null
  const dual = previewQuery.data?.dual ?? null
  const meta: PreviewMeta | null = previewQuery.data
    ? {
        symbol0: previewQuery.data.symbol0,
        symbol1: previewQuery.data.symbol1,
        fee: previewQuery.data.fee,
        depositToken: previewQuery.data.depositToken,
      }
    : null
  const busy = mintBusy
    ? 'mint'
    : previewQuery.isFetching
      ? 'preview'
      : null
  const error =
    mintError ??
    (previewQuery.error instanceof Error
      ? previewQuery.error.message
      : previewQuery.error
        ? 'Preview failed'
        : null)

  async function runMint() {
    setMintError(null)
    setMintBusy(true)
    try {
      if (!wallet.address) await wallet.connect()
      const c = await buildCtx()
      const result = await mintPool(poolAddress as Address, c, mintOpts)
      const protocol = result.protocol === 'v4' ? 'v4' : 'v3'
      await createMark.mutateAsync({
        token_id: result.tokenId.toString(),
        protocol,
        pool_address: String(result.poolAddress),
        pair_label:
          pairLabel ||
          (meta ? `${meta.symbol0}/${meta.symbol1}` : null),
        token_address: tokenAddress ?? null,
        deposit_symbol: tokenSymbol ?? null,
        owner_address: c.owner,
        entry_value_usd: 0,
        mint_tx: result.hash,
        ...(protocol === 'v4' && result.poolKey
          ? {
              pool_id: result.poolId ?? String(result.poolAddress),
              pool_key: result.poolKey,
              fee: result.fee,
              tick_spacing: result.tickSpacing ?? result.poolKey.tickSpacing,
            }
          : {}),
      })
      setTxLink(result.txLink)
      setMintedText(`Minted #${result.tokenId} (${protocol})\n${result.txLink}`)
    } catch (e) {
      setMintError(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      setMintBusy(false)
    }
  }

  function applyPreset(kind: 'narrow' | 'wide' | 'full') {
    setMintedText(null)
    setMintError(null)
    if (mode === 'single') {
      if (kind === 'full') {
        setMintError('Full range is dual-sided only — switch mode to Dual')
        return
      }
      setWidthPercent(kind === 'narrow' ? 10 : 30)
      return
    }
    if (kind === 'full') {
      setFullRange(true)
      setMinPct(-99)
      setMaxPct(99)
    } else {
      setFullRange(false)
      const w = kind === 'narrow' ? 10 : 30
      setMinPct(-w)
      setMaxPct(w)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-3xl bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-white font-bold text-lg">Add CLMM v1 (UniV3)</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {pairLabel ||
                (meta
                  ? `${meta.symbol0}/${meta.symbol1}`
                  : 'Loading pool…')}{' '}
              · Rabby
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

        <div className="flex gap-2">
          {(['single', 'dual'] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={m === 'dual' && mintProtocol === 'v4'}
              title={
                m === 'dual' && mintProtocol === 'v4'
                  ? 'Dual mint is v3-only'
                  : undefined
              }
              onClick={() => {
                setMintedText(null)
                setMintError(null)
                setMode(m)
                if (m === 'single') setFullRange(false)
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded ${
                mode === m
                  ? 'bg-emerald-600 text-black'
                  : 'bg-gray-800 text-gray-300'
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {m === 'single' ? 'Single-sided' : 'Dual-sided'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Left: range */}
          <div className="space-y-3 border border-gray-800 rounded p-3">
            <div className="text-xs text-gray-400 uppercase tracking-wide">
              Price range
            </div>
            {tokenAddress ? (
              <div className="h-[180px] w-full rounded overflow-hidden border border-gray-800">
                <GmgnChartEmbed
                  tokenAddress={tokenAddress}
                  chain="robinhood"
                  interval="5"
                  className="w-full h-full"
                  height="180px"
                  title={`GMGN · ${tokenSymbol || 'token'}`}
                />
              </div>
            ) : (
              <p className="text-xs text-gray-500">
                No base token for chart — set range below.
              </p>
            )}

            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['narrow', 'Narrow'],
                  ['wide', 'Wide'],
                  ['full', 'Full'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => applyPreset(id)}
                  className="px-2 py-1 text-[11px] border border-gray-700 text-gray-300 hover:border-emerald-600"
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'single' ? (
              <label className="block text-xs text-gray-400">
                Width % (out-of-range band)
                <input
                  type="range"
                  min={5}
                  max={50}
                  value={widthPercent}
                  onChange={(e) => setWidthPercent(Number(e.target.value))}
                  className="w-full mt-1"
                />
                <span className="text-white font-mono">{widthPercent}%</span>
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-gray-400">
                  Min %
                  <input
                    type="number"
                    value={minPct}
                    disabled={fullRange}
                    onChange={(e) => setMinPct(Number(e.target.value))}
                    className="w-full mt-1 bg-black border border-gray-700 text-white px-2 py-1 rounded"
                  />
                </label>
                <label className="text-xs text-gray-400">
                  Max %
                  <input
                    type="number"
                    value={maxPct}
                    disabled={fullRange}
                    onChange={(e) => setMaxPct(Number(e.target.value))}
                    className="w-full mt-1 bg-black border border-gray-700 text-white px-2 py-1 rounded"
                  />
                </label>
                {fullRange ? (
                  <p className="col-span-2 text-[11px] text-amber-400">
                    Full range (min→max usable ticks)
                  </p>
                ) : null}
              </div>
            )}
          </div>

          {/* Right: zap confirm */}
          <div className="space-y-3 border border-gray-800 rounded p-3">
            <div className="text-xs text-gray-400 uppercase tracking-wide">
              Zap in / confirm
            </div>
            <label className="block text-xs text-gray-400">
              Balance % to use
              <input
                type="range"
                min={10}
                max={100}
                value={balancePercent}
                onChange={(e) => setBalancePercent(Number(e.target.value))}
                className="w-full mt-1"
              />
              <span className="text-white font-mono">{balancePercent}%</span>
            </label>

            {mode === 'dual' && dual ? (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="border border-gray-700 rounded p-2">
                  <div className="text-gray-500">{dual.symbol0}</div>
                  <div className="text-white font-mono">
                    {dual.amount0Human.toPrecision(6)}
                  </div>
                </div>
                <div className="border border-gray-700 rounded p-2">
                  <div className="text-gray-500">{dual.symbol1}</div>
                  <div className="text-white font-mono">
                    {dual.amount1Human.toPrecision(6)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="border border-gray-700 rounded p-2 text-xs">
                <div className="text-gray-500">Deposit (single)</div>
                <div className="text-white font-mono">
                  {meta
                    ? `${tokenSymbol || 'quote'} · ${balancePercent}% bal · width ${widthPercent}%`
                    : '—'}
                </div>
              </div>
            )}

            <div className="text-[11px] text-gray-400 space-y-1 border border-gray-800 rounded p-2 bg-black/30">
              {mode === 'dual' && dual?.priceImpactPct != null ? (
                <div>
                  Price impact:{' '}
                  <span
                    className={
                      dual.priceImpactPct < 0 ? 'text-red-400' : 'text-emerald-400'
                    }
                  >
                    {dual.priceImpactPct.toFixed(2)}%
                  </span>{' '}
                  (Kyber)
                </div>
              ) : (
                <div>Price impact: — (no swap or quote pending)</div>
              )}
              <div>Est. gas: wallet estimate at confirm (no platform fee)</div>
              <div>
                Mode:{' '}
                {mode === 'single'
                  ? 'single-sided (out of range)'
                  : 'dual-sided zap → mint'}
              </div>
            </div>

            {preview ? (
              <pre className="text-[11px] text-gray-300 bg-black/40 border border-gray-700 rounded p-2 whitespace-pre-wrap overflow-x-auto max-h-36">
                {preview}
              </pre>
            ) : (
              <p className="text-xs text-gray-500">
                {busy === 'preview'
                  ? 'Building preview…'
                  : 'Connect Rabby to preview range / deposit.'}
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
                onClick={() => {
                  setMintedText(null)
                  setMintError(null)
                  void previewQuery.refetch()
                }}
                disabled={!!busy}
                className="w-full py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-sm rounded"
              >
                {busy === 'preview' ? '…' : 'Refresh quote'}
              </button>
              <button
                type="button"
                onClick={() => void runMint()}
                disabled={!!busy || !wallet.address}
                className="w-full py-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 text-white text-sm rounded font-medium"
              >
                {busy === 'mint'
                  ? 'Minting…'
                  : mode === 'dual'
                    ? 'Zap Now'
                    : 'Confirm mint'}
              </button>
            </div>
          </div>
        </div>

        <div className="text-[11px] text-gray-500 font-mono break-all">
          Pool {poolAddress}
          {meta ? ` · fee ${(meta.fee / 10000).toFixed(2)}%` : ''}
        </div>
      </div>
    </div>
  )
}

export default function RhClmmLpSheet({
  open,
  onClose,
  poolAddress,
  proto,
  pairLabel,
  tokenAddress,
  tokenSymbol,
}: RhClmmLpSheetProps) {
  if (!open) return null
  return (
    <RhClmmLpSheetBody
      poolAddress={poolAddress}
      proto={proto}
      pairLabel={pairLabel}
      tokenAddress={tokenAddress}
      tokenSymbol={tokenSymbol}
      onClose={onClose}
    />
  )
}
