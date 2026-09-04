'use client'

import { useEffect } from 'react'
import type { GmgnTokenSnapshot } from '@/strategies/gmgn-token-snapshot'
import { useQuery } from '@tanstack/react-query'

export type GmgnSnapshotWithBan = GmgnTokenSnapshot & {
  concentrationBanned?: boolean
  concentrationReasons?: string[]
}

type SnapshotResponse = GmgnSnapshotWithBan & {
  success: boolean
  error?: string
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (Math.abs(n) < 0.01 && n !== 0) return `${n.toFixed(2)}%`
  return `${n.toFixed(2).replace(/\.?0+$/, '')}%`
}

function authLabel(active: boolean | null | undefined): string {
  if (active == null) return '—'
  return active ? 'Yes' : 'No'
}

function pctTone(n: number | null | undefined, safeBelow = 20): string {
  if (n == null) return 'text-gray-300'
  if (n <= safeBelow) return 'text-emerald-400'
  if (n <= 50) return 'text-amber-300'
  return 'text-red-300'
}

function authTone(active: boolean | null | undefined): string {
  if (active == null) return 'text-gray-300'
  return active ? 'text-amber-300' : 'text-emerald-400'
}

type Tile = {
  key: string
  label: string
  value: string
  valueClass: string
  accent?: string
}

function tilesFrom(snap: GmgnTokenSnapshot): Tile[] {
  const snipersValue =
    snap.snipersHoldPct != null
      ? fmtPct(snap.snipersHoldPct)
      : snap.sniperWalletCount != null
        ? String(Math.round(snap.sniperWalletCount))
        : '—'
  const snipersTone =
    snap.snipersHoldPct != null
      ? pctTone(snap.snipersHoldPct, 5)
      : snap.sniperWalletCount != null && snap.sniperWalletCount > 20
        ? 'text-red-300'
        : 'text-emerald-400'

  return [
    {
      key: 'top10',
      label: 'Top 10 H.',
      value: fmtPct(snap.top10HoldPct),
      valueClass: pctTone(snap.top10HoldPct, 20),
    },
    {
      key: 'dev',
      label: 'Dev H.',
      value: fmtPct(snap.devHoldPct),
      valueClass: pctTone(snap.devHoldPct, 5),
    },
    {
      key: 'snipers',
      label: 'Snipers H.',
      value: snipersValue,
      valueClass: snipersTone,
    },
    {
      key: 'freeze',
      label: 'Freeze Auth',
      value: authLabel(snap.freezeAuthActive),
      valueClass: authTone(snap.freezeAuthActive),
    },
    {
      key: 'mint',
      label: 'Mint Auth',
      value: authLabel(snap.mintAuthActive),
      valueClass: authTone(snap.mintAuthActive),
    },
    {
      key: 'dex',
      label: 'Dex',
      value: snap.dexBoostLabel ?? '—',
      valueClass: snap.dexBoostLabel ? 'text-yellow-300' : 'text-gray-400',
      accent: snap.dexBoostLabel?.startsWith('Boost')
        ? snap.dexBoostLabel.replace(/^Boost\s*/, '')
        : undefined,
    },
    {
      key: 'pro',
      label: 'Pro Traders',
      value: fmtPct(snap.proTradersPct),
      valueClass: 'text-gray-100',
    },
    {
      key: 'insiders',
      label: 'Insiders H.',
      value: fmtPct(snap.insidersHoldPct),
      valueClass: pctTone(snap.insidersHoldPct, 5),
    },
    {
      key: 'bundlers',
      label: 'Bundlers H.',
      value: fmtPct(snap.bundlersHoldPct),
      valueClass: pctTone(snap.bundlersHoldPct, 5),
    },
  ]
}

function TileValue({ tile }: { tile: Tile }) {
  if (tile.key === 'dex' && tile.value.startsWith('Boost')) {
    return (
      <>
        <span className="text-yellow-300">Boost</span>
        {tile.accent ? (
          <span className="text-gray-400"> {tile.accent}</span>
        ) : null}
      </>
    )
  }
  return <>{tile.value}</>
}

export default function GmgnTokenStatsGrid({
  tokenAddress,
  variant = 'rail',
  onConcentrationBan,
}: {
  tokenAddress: string
  variant?: 'row' | 'rail'
  onConcentrationBan?: (payload: {
    banned: boolean
    reasons: string[]
  }) => void
}) {
  const isRail = variant === 'rail'

  const query = useQuery({
    queryKey: ['gmgn-token-snapshot', tokenAddress],
    queryFn: async (): Promise<GmgnSnapshotWithBan> => {
      const res = await fetch(
        `/api/gmgn/token-snapshot?address=${encodeURIComponent(tokenAddress)}`,
      )
      const json = (await res.json()) as SnapshotResponse
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load GMGN token info')
      }
      return json
    },
    enabled: Boolean(tokenAddress),
    staleTime: 60_000,
    refetchInterval: 120_000,
  })

  useEffect(() => {
    if (!onConcentrationBan || !query.data) return
    onConcentrationBan({
      banned: Boolean(query.data.concentrationBanned),
      reasons: query.data.concentrationReasons ?? [],
    })
  }, [onConcentrationBan, query.data])

  if (query.isLoading) {
    return (
      <div
        className={
          isRail
            ? 'grid grid-cols-1 gap-1 max-h-[320px] overflow-y-auto'
            : 'grid grid-cols-3 gap-2'
        }
      >
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className={`animate-pulse rounded-lg border border-gray-700 bg-gray-900/80 ${
              isRail ? 'h-8' : 'h-16'
            }`}
          />
        ))}
      </div>
    )
  }

  if (query.error || !query.data) {
    return (
      <p
        className={`rounded-lg border border-gray-700 bg-gray-900/60 text-amber-200/80 ${
          isRail ? 'px-1.5 py-1 text-[11px]' : 'px-3 py-2 text-xs'
        }`}
      >
        GMGN info unavailable
        {query.error instanceof Error ? `: ${query.error.message}` : ''}
      </p>
    )
  }

  const tiles = tilesFrom(query.data)

  return (
    <div
      className={
        isRail
          ? 'grid grid-cols-1 gap-1 max-h-[320px] overflow-y-auto'
          : 'grid grid-cols-3 gap-2'
      }
    >
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className={`rounded-lg border border-gray-700 bg-gray-950/80 ${
            isRail ? 'px-1.5 py-1' : 'px-2.5 py-2'
          }`}
        >
          <p
            className={`font-semibold leading-tight ${tile.valueClass} ${
              isRail ? 'text-xs' : 'text-sm'
            }`}
          >
            <TileValue tile={tile} />
          </p>
          <p
            className={`text-gray-500 underline decoration-dashed decoration-gray-600 underline-offset-2 ${
              isRail ? 'mt-0.5 text-[11px] leading-tight' : 'mt-1 text-xs'
            }`}
          >
            {tile.label}
          </p>
        </div>
      ))}
    </div>
  )
}
