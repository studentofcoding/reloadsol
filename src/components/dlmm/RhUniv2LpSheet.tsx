'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseUnits, type Address } from 'viem'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import {
  useCreateRhUniv2Position,
  usePatchRhUniv2Position,
} from '@/hooks/useRhUniv2Positions'
import type { RhUniv2Position } from '@/types/dlmm'
import type {
  LpTerminalPoolRaw,
  LpTerminalPoolsResponse,
  LpTerminalTokenMeta,
} from '@/utils/dlmm/lp-terminal-pools'
import { getLpTerminalPoolDeepLink } from '@/utils/dlmm/lp-terminal'
import {
  DEFAULT_RH_SLIPPAGE_BPS,
  RH_AMOUNT_CHIPS,
  RH_USDG,
  RH_WETH,
  erc20Abi,
  exceedsTvlSoftWarn,
  explorerTxUrl,
  isRhUniv2QuotePool,
  normalizeAddress,
  pickHighestTvlUniv2QuotePool,
  quoteSymbolForAddress,
} from '@/utils/dlmm/rh-univ2'
import {
  executeRhUniv2RemoveLp,
  executeRhUniv2ZapAdd,
} from '@/utils/dlmm/rh-univ2-lp'

export type RhUniv2LpSheetProps = {
  open: boolean
  onClose: () => void
  /** Token CA — sheet picks highest-TVL USDG/WETH univ2 pool */
  tokenAddress?: string
  /** Direct pool address (from pools table) */
  poolAddress?: string
  tokenSymbol?: string
  /** Close existing position */
  closePosition?: RhUniv2Position | null
}

type Step =
  | 'idle'
  | 'resolve'
  | 'batch'
  | 'persist'
  | 'done'
  | 'error'

async function fetchPoolsForToken(token: string): Promise<{
  pools: LpTerminalPoolRaw[]
  tokens: Record<string, LpTerminalTokenMeta>
}> {
  const sp = new URLSearchParams({
    q: token,
    proto: 'univ2',
    sort: 'tvl',
    limit: '100',
  })
  const res = await fetch(`/api/dlmm/lp-terminal-pools?${sp}`)
  const data = (await res.json()) as LpTerminalPoolsResponse & {
    success?: boolean
    error?: string
  }
  if (!res.ok || data.success === false) {
    throw new Error(data.error || 'Failed to load pools')
  }
  return { pools: data.pools ?? [], tokens: data.tokens ?? {} }
}

async function fetchPoolByAddress(address: string): Promise<{
  pool: LpTerminalPoolRaw | null
  tokens: Record<string, LpTerminalTokenMeta>
}> {
  const sp = new URLSearchParams({
    q: address,
    proto: 'univ2',
    sort: 'tvl',
    limit: '20',
  })
  const res = await fetch(`/api/dlmm/lp-terminal-pools?${sp}`)
  const data = (await res.json()) as LpTerminalPoolsResponse & {
    success?: boolean
  }
  const pools = data.pools ?? []
  const pool =
    pools.find(
      (p) => normalizeAddress(p.address) === normalizeAddress(address),
    ) ?? null
  return { pool, tokens: data.tokens ?? {} }
}

export default function RhUniv2LpSheet({
  open,
  onClose,
  tokenAddress,
  poolAddress,
  tokenSymbol,
  closePosition,
}: RhUniv2LpSheetProps) {
  const wallet = useRhEvmWallet()
  const createPos = useCreateRhUniv2Position()
  const patchPos = usePatchRhUniv2Position()

  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_RH_SLIPPAGE_BPS)
  const [step, setStep] = useState<Step>('idle')
  const [status, setStatus] = useState('')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isClose = Boolean(closePosition)

  const [resolved, setResolved] = useState<{
    pool: LpTerminalPoolRaw
    quoteAddress: Address
    quoteSymbol: 'USDG' | 'WETH'
    baseAddress: Address
    tvlUsd: number
    pairLabel: string
  } | null>(() => {
    if (!closePosition) return null
    return {
      pool: {
        proto: 'univ2',
        address: closePosition.pool_address,
        token0: closePosition.token_address,
        token1: closePosition.quote_symbol === 'WETH' ? RH_WETH : RH_USDG,
      },
      quoteAddress:
        closePosition.quote_symbol === 'WETH' ? RH_WETH : RH_USDG,
      quoteSymbol: closePosition.quote_symbol,
      baseAddress: closePosition.token_address as Address,
      tvlUsd: 0,
      pairLabel: closePosition.pair_label || closePosition.quote_symbol,
    }
  })

  // Async pool resolve for add mode only (close mode uses useState init above).
  useEffect(() => {
    if (!open || isClose) return

    let cancelled = false
    ;(async () => {
      setStep('resolve')
      setStatus('Resolving univ2 pool…')
      setError(null)
      try {
        if (poolAddress) {
          const { pool, tokens } = await fetchPoolByAddress(poolAddress)
          if (cancelled) return
          if (!pool || !isRhUniv2QuotePool(pool, tokens)) {
            throw new Error('Pool is not a USDG/WETH univ2 pair')
          }
          const t0 = normalizeAddress(pool.token0)
          const t1 = normalizeAddress(pool.token1)
          const q0 = quoteSymbolForAddress(pool.token0)
          const q1 = quoteSymbolForAddress(pool.token1)
          const quoteSymbol = q0 || q1
          if (!quoteSymbol) throw new Error('No USDG/WETH quote side')
          const quoteAddress = (q0 ? pool.token0 : pool.token1) as Address
          const baseAddress = (q0 ? pool.token1 : pool.token0) as Address
          setResolved({
            pool,
            quoteAddress,
            quoteSymbol,
            baseAddress,
            tvlUsd: Number(pool.tvlUsd) || 0,
            pairLabel: `${tokens[t0]?.symbol || t0.slice(0, 6)}/${tokens[t1]?.symbol || t1.slice(0, 6)}`,
          })
        } else if (tokenAddress) {
          const { pools, tokens } = await fetchPoolsForToken(tokenAddress)
          if (cancelled) return
          const best = pickHighestTvlUniv2QuotePool(
            pools,
            tokenAddress,
            tokens,
          )
          if (!best) {
            throw new Error('No univ2 USDG/WETH pool found for this token')
          }
          setResolved({
            pool: best.pool,
            quoteAddress: best.quoteAddress as Address,
            quoteSymbol: best.quoteSymbol,
            baseAddress: best.baseAddress as Address,
            tvlUsd: best.tvlUsd,
            pairLabel: `${tokenSymbol || 'TOKEN'}/${best.quoteSymbol}`,
          })
        } else {
          throw new Error('tokenAddress or poolAddress required')
        }
        setStep('idle')
        setStatus('')
      } catch (err) {
        if (cancelled) return
        setStep('error')
        setError(err instanceof Error ? err.message : 'Resolve failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, tokenAddress, poolAddress, tokenSymbol, isClose])

  const amountNum = Number(amount)
  const tvlWarn = useMemo(() => {
    if (!resolved || !(amountNum > 0)) return false
    const quoteUsd =
      resolved.quoteSymbol === 'USDG' ? amountNum : amountNum * 0 // unknown ETH px
    if (resolved.quoteSymbol === 'USDG') {
      return exceedsTvlSoftWarn(quoteUsd, resolved.tvlUsd)
    }
    return false
  }, [resolved, amountNum])

  const runAdd = useCallback(async () => {
    if (!resolved) return
    if (!(amountNum > 0)) {
      setError('Enter an amount')
      return
    }
    setError(null)
    try {
      if (!wallet.address) await wallet.connect()
      await wallet.ensureChain()
      const wc = await wallet.getWalletClient()
      const account = (wc.account?.address ?? wallet.address) as Address | undefined
      if (!account) throw new Error('Wallet not connected')
      const { publicClient } = wallet

      const decimals = (await publicClient.readContract({
        address: resolved.quoteAddress,
        abi: erc20Abi,
        functionName: 'decimals',
      })) as number
      const quoteAmount = parseUnits(amount, decimals)
      if (quoteAmount <= BigInt(0)) throw new Error('Amount too small')

      setStep('batch')
      setStatus('Batch wrap/approve/swap/add (one confirm when supported)…')
      const { hash: addHash } = await executeRhUniv2ZapAdd({
        publicClient,
        walletClient: wc,
        account,
        quoteAddress: resolved.quoteAddress,
        baseAddress: resolved.baseAddress,
        quoteAmount,
        slippageBps,
      })
      setTxHash(addHash)

      const entryUsd = amountNum
      setStep('persist')
      setStatus('Saving position…')
      await createPos.mutateAsync({
        pool_address: resolved.pool.address,
        pair_label: resolved.pairLabel,
        token_address: resolved.baseAddress,
        quote_symbol: resolved.quoteSymbol,
        owner_address: account,
        lp_token_address: resolved.pool.address,
        entry_quote_amount: amountNum,
        entry_value_usd: entryUsd,
        current_value_usd: entryUsd,
        add_tx: addHash,
      })

      setStep('done')
      setStatus('LP added')
    } catch (err) {
      setStep('error')
      setError(err instanceof Error ? err.message : 'Add LP failed')
    }
  }, [
    resolved,
    amountNum,
    amount,
    slippageBps,
    wallet,
    createPos,
    wallet.ensureChain,
  ])

  const runClose = useCallback(async () => {
    if (!closePosition || !resolved) return
    setError(null)
    try {
      if (!wallet.address) await wallet.connect()
      await wallet.ensureChain()
      const wc = await wallet.getWalletClient()
      const account = (wc.account?.address ?? wallet.address) as Address | undefined
      if (!account) throw new Error('Wallet not connected')
      const { publicClient } = wallet
      const lp = closePosition.lp_token_address as Address

      setStep('batch')
      setStatus('Batch approve LP + remove (one confirm when supported)…')
      const { hash } = await executeRhUniv2RemoveLp({
        publicClient,
        walletClient: wc,
        account,
        lp,
      })
      setTxHash(hash)

      await patchPos.mutateAsync({
        id: closePosition.id,
        status: 'closed',
        remove_tx: hash,
      })
      setStep('done')
      setStatus('Position closed')
    } catch (err) {
      setStep('error')
      setError(err instanceof Error ? err.message : 'Close failed')
    }
  }, [closePosition, resolved, wallet, patchPos, wallet.ensureChain])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-white font-bold text-lg">
              {isClose ? 'Close DAMM v2 LP' : 'Add DAMM v2 LP (UniV2)'}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {resolved
                ? `${resolved.pairLabel} · ${resolved.quoteSymbol} quote · Rabby · ArrowRPC`
                : 'Resolving univ2 pool…'}
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

        {resolved && (
          <div className="text-[11px] text-gray-500 font-mono break-all">
            Pool {resolved.pool.address}
            {resolved.tvlUsd > 0 ? ` · TVL $${resolved.tvlUsd.toLocaleString()}` : ''}
          </div>
        )}

        {!isClose && (
          <>
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Quote amount ({resolved?.quoteSymbol || '…'})
              </label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="w-full bg-black border border-gray-700 text-white px-3 py-2 rounded text-sm"
                inputMode="decimal"
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {RH_AMOUNT_CHIPS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setAmount(String(n))}
                    className="px-2 py-1 text-xs border border-gray-700 text-gray-300 hover:border-emerald-600"
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Slippage (bps)
              </label>
              <input
                type="number"
                value={slippageBps}
                onChange={(e) => setSlippageBps(Number(e.target.value) || 100)}
                className="w-24 bg-black border border-gray-700 text-white px-2 py-1 rounded text-sm"
              />
              <span className="text-xs text-gray-500 ml-2">
                {(slippageBps / 100).toFixed(2)}%
              </span>
            </div>
            {tvlWarn && (
              <p className="text-amber-400 text-xs">
                Amount &gt; 10% of pool TVL — high impact risk.
              </p>
            )}
          </>
        )}

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

          {isClose ? (
            <button
              type="button"
              onClick={() => void runClose()}
              disabled={!resolved || step === 'batch' || step === 'done'}
              className="w-full py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 text-white text-sm rounded font-medium"
            >
              Remove liquidity
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runAdd()}
              disabled={
                !resolved || !amountNum || step === 'batch' || step === 'done'
              }
              className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-black text-sm rounded font-medium"
            >
              Zap + Add LP
            </button>
          )}

          {resolved && (
            <a
              href={getLpTerminalPoolDeepLink(resolved.pool.address)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-center text-xs text-gray-500 hover:text-gray-300"
            >
              LP Terminal ↗
            </a>
          )}
        </div>

        {(status || step !== 'idle') && (
          <p className="text-xs text-gray-400">
            [{step}] {status}
          </p>
        )}
        {txHash && (
          <a
            href={explorerTxUrl(txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline break-all block"
          >
            Tx {txHash.slice(0, 10)}… ↗
          </a>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {wallet.error && (
          <p className="text-xs text-red-400">{wallet.error}</p>
        )}
      </div>
    </div>
  )
}
