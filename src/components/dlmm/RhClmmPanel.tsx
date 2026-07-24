'use client'

import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import { useRhEvmWallet } from '@/hooks/useRhEvmWallet'
import {
  useCreateRhClmmMark,
  usePatchRhClmmMark,
  useRhClmmMarks,
} from '@/hooks/useRhClmmPositions'
import {
  closeOwnerPosition,
  listOwnerPositions,
  mintQuick,
  previewQuickMint,
  type RhClmmCtx,
} from '@/utils/dlmm/rh-clmm'
import {
  DEFAULT_BALANCE_PERCENT,
  DEFAULT_WIDTH_PERCENT,
} from '@/utils/dlmm/rh-clmm/config'

function isRhCa(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s.trim())
}

function fmtUsd(n: number) {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`
  return `$${n.toFixed(2)}`
}

export default function RhClmmPanel() {
  const wallet = useRhEvmWallet()
  const createMark = useCreateRhClmmMark()
  const patchMark = usePatchRhClmmMark()
  const { data: marksData, refetch: refetchMarks } = useRhClmmMarks(
    wallet.address,
    'open',
  )
  const marks = marksData?.positions ?? []

  const [ca, setCa] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [onChain, setOnChain] = useState<
    Awaited<ReturnType<typeof listOwnerPositions>>
  >([])

  const knownV4Ids = useMemo(
    () =>
      marks
        .filter((m) => m.protocol === 'v4')
        .map((m) => BigInt(m.token_id)),
    [marks],
  )

  const markByKey = useMemo(() => {
    const map = new Map<string, (typeof marks)[0]>()
    for (const m of marks) {
      map.set(`${m.protocol}:${m.token_id}`, m)
    }
    return map
  }, [marks])

  async function ctx(): Promise<RhClmmCtx> {
    if (!wallet.address) throw new Error('Connect Rabby first')
    const walletClient = await wallet.getWalletClient()
    return {
      publicClient: wallet.publicClient,
      walletClient,
      owner: wallet.address,
    }
  }

  async function runPreview() {
    setError(null)
    setPreview(null)
    if (!isRhCa(ca)) {
      setError('Enter a valid 0x token address')
      return
    }
    setBusy('preview')
    try {
      const c = await ctx()
      const text = await previewQuickMint(ca.trim() as Address, c)
      setPreview(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
    } finally {
      setBusy(null)
    }
  }

  async function runMint() {
    setError(null)
    if (!isRhCa(ca)) {
      setError('Enter a valid 0x token address')
      return
    }
    setBusy('mint')
    try {
      const c = await ctx()
      const result = await mintQuick(ca.trim() as Address, c)
      const protocol = result.protocol === 'v4' ? 'v4' : 'v3'
      const created = await createMark.mutateAsync({
        token_id: result.tokenId.toString(),
        protocol,
        pool_address: String(result.poolAddress),
        pair_label: `${result.token0.slice(0, 6)}/${result.token1.slice(0, 6)}`,
        token_address: ca.trim().toLowerCase(),
        owner_address: wallet.address,
        entry_value_usd: 0,
        mint_tx: result.hash,
      })
      setPreview(`Minted #${result.tokenId} (${protocol})\n${result.txLink}`)
      await refreshPositions()
      // Best-effort cost basis from first on-chain mark after mint
      try {
        const c2 = await ctx()
        const list = await listOwnerPositions(c2, [
          ...knownV4Ids,
          ...(protocol === 'v4' ? [result.tokenId] : []),
        ])
        const live = list.find(
          (p) =>
            p.protocol === protocol && p.tokenId === result.tokenId,
        )
        if (live && live.valueUsd > 0 && created.position?.id) {
          await patchMark.mutateAsync({
            id: created.position.id,
            current_value_usd: live.valueUsd,
            entry_value_usd: live.valueUsd,
            pnl_pct: 0,
          })
        }
      } catch {
        /* mark stays 0 until refresh */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mint failed')
    } finally {
      setBusy(null)
    }
  }

  async function refreshPositions() {
    setError(null)
    setBusy('list')
    try {
      const c = await ctx()
      const list = await listOwnerPositions(c, knownV4Ids)
      setOnChain(list)
      await refetchMarks()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'List failed')
    } finally {
      setBusy(null)
    }
  }

  async function runClose(
    tokenId: bigint,
    protocol: 'v3' | 'v4',
    markId?: string,
  ) {
    setError(null)
    setBusy(`close-${tokenId}`)
    try {
      const c = await ctx()
      const result = await closeOwnerPosition(c, tokenId, protocol)
      if (markId) {
        await patchMark.mutateAsync({
          id: markId,
          status: 'closed',
          close_tx: result.hash,
          current_value_usd: 0,
          pnl_pct: 0,
        })
      }
      await refreshPositions()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Close failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">
            Uni v3/v4 (CLMM) · Robinhood
          </h2>
          <p className="text-gray-400 text-sm mt-1">
            Single-sided quick mint (width {DEFAULT_WIDTH_PERCENT}% ·{' '}
            {DEFAULT_BALANCE_PERCENT}% balance) · Rabby signs on chain 4663
          </p>
        </div>
        {!wallet.address ? (
          <button
            type="button"
            onClick={() => void wallet.connect()}
            disabled={wallet.connecting || !wallet.hasProvider}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white text-sm rounded"
          >
            {!wallet.hasProvider
              ? 'No Rabby'
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
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={ca}
          onChange={(e) => setCa(e.target.value)}
          placeholder="Token CA 0x…"
          className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-white font-mono"
        />
        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={!!busy || !wallet.address}
          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-sm rounded"
        >
          {busy === 'preview' ? '…' : 'Preview'}
        </button>
        <button
          type="button"
          onClick={() => void runMint()}
          disabled={!!busy || !wallet.address}
          className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-800 text-white text-sm rounded font-medium"
        >
          {busy === 'mint' ? 'Minting…' : 'Confirm mint'}
        </button>
      </div>

      {preview ? (
        <pre className="text-xs text-gray-300 bg-black/40 border border-gray-700 rounded p-3 whitespace-pre-wrap overflow-x-auto">
          {preview}
        </pre>
      ) : null}

      {error ? (
        <p className="text-sm text-red-400 break-words">{error}</p>
      ) : null}

      <div className="flex items-center justify-between">
        <h3 className="text-white font-semibold">Positions</h3>
        <button
          type="button"
          onClick={() => void refreshPositions()}
          disabled={!!busy || !wallet.address}
          className="text-xs text-gray-300 hover:text-white underline disabled:no-underline disabled:text-gray-600"
        >
          {busy === 'list' ? 'Refreshing…' : 'Refresh on-chain'}
        </button>
      </div>

      {onChain.length === 0 ? (
        <p className="text-gray-500 text-sm">
          {wallet.address
            ? 'No loaded positions — refresh after mint, or none open.'
            : 'Connect Rabby to list NPM / POSM positions.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-gray-400 border-b border-gray-700">
              <tr>
                <th className="py-2 pr-3">ID</th>
                <th className="py-2 pr-3">Pair</th>
                <th className="py-2 pr-3">Range</th>
                <th className="py-2 pr-3">Mark</th>
                <th className="py-2 pr-3">Entry</th>
                <th className="py-2 pr-3">PnL</th>
                <th className="py-2 pr-3" />
              </tr>
            </thead>
            <tbody>
              {onChain.map((p) => {
                const key = `${p.protocol}:${p.tokenId.toString()}`
                const mark = markByKey.get(key)
                const entry = mark?.entry_value_usd ?? 0
                const live = p.valueUsd
                const pnl =
                  entry > 0 ? ((live - entry) / entry) * 100 : mark?.pnl_pct
                return (
                  <tr
                    key={key}
                    className="border-b border-gray-800 text-gray-200"
                  >
                    <td className="py-2 pr-3 font-mono text-xs">
                      #{p.tokenId.toString()}
                      <span className="text-gray-500 ml-1">
                        {p.protocol}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {p.symbol0}/{p.symbol1}
                      {!p.inRange ? (
                        <span className="ml-1 text-amber-400 text-xs">OOR</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-400">
                      {p.tickLower} → {p.tickUpper}
                    </td>
                    <td className="py-2 pr-3">{fmtUsd(live)}</td>
                    <td className="py-2 pr-3">
                      {entry > 0 ? fmtUsd(entry) : '—'}
                    </td>
                    <td
                      className={`py-2 pr-3 ${
                        pnl != null && pnl >= 0
                          ? 'text-emerald-400'
                          : pnl != null
                            ? 'text-red-400'
                            : 'text-gray-500'
                      }`}
                    >
                      {pnl != null && Number.isFinite(pnl)
                        ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`
                        : '—'}
                    </td>
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        onClick={() =>
                          void runClose(p.tokenId, p.protocol, mark?.id)
                        }
                        disabled={!!busy}
                        className="text-xs px-2 py-1 rounded bg-red-800 hover:bg-red-700 disabled:bg-gray-800 text-white"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
