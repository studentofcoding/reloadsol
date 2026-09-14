'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useClimateDisplay } from '@/hooks/useClimateDisplay'
import { useDataPublicScout } from '@/hooks/useDataPublicScout'
import { useBuybulkPaperNotches } from '@/hooks/useBuybulkPaperNotches'
import { tokenSearchDetailHref } from '@/components/signals/shared/token-search-href'
import {
  canPaperNotchFromClimate,
  paperNotchDisabledTip,
  DATA_PUBLIC_STUDY_DISCLAIMER,
  type ScoutCandidate,
  type ScoutChain,
} from '@/utils/data-public-scout'
import {
  readPaperNotchesFromStorage,
  type PaperNotch,
} from '@/utils/paper-notch-store'
import { formatCompactNumber } from '@/utils/formatters'

type Tab = 'all' | ScoutChain

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'robinhood', label: 'RH' },
  { id: 'solana', label: 'Sol' },
]

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function formatUsd(n: number | null): string {
  if (n == null) return '—'
  return `$${formatCompactNumber(n)}`
}

function chainBadge(chain: ScoutChain): string {
  return chain === 'robinhood' ? 'RH' : 'Sol'
}

export default function DataPublicObserveStrip({
  onInspectMint,
}: {
  onInspectMint?: (mint: string) => void
}) {
  const scout = useDataPublicScout('all')
  const climate = useClimateDisplay()
  const [tab, setTab] = useState<Tab>('all')
  const cache = useMemo<PaperNotch[]>(
    () => readPaperNotchesFromStorage(storage()),
    [],
  )
  const paper = useBuybulkPaperNotches(cache)
  const [flash, setFlash] = useState<string | null>(null)

  const climateLabel = climate.data?.label ?? 'Unknown'
  const paperAllowed = canPaperNotchFromClimate(climateLabel)
  const disabledTip = paperNotchDisabledTip(climateLabel)

  const rows = useMemo(() => {
    const all = scout.data?.rows ?? []
    if (tab === 'all') return all
    return all.filter((r) => r.chain === tab)
  }, [scout.data?.rows, tab])

  const notedKeys = useMemo(() => new Set(paper.notches.map((n) => n.key)), [paper.notches])

  const onPaperNote = useCallback(
    async (row: ScoutCandidate) => {
      if (!paperAllowed) {
        setFlash(disabledTip)
        return
      }
      try {
        const result = await paper.note(row)
        if (!result.ok) {
          setFlash(
            result.reason === 'climate_not_safe'
              ? result.error || disabledTip
              : result.reason === 'duplicate'
                ? 'Already paper-noted.'
                : result.error || 'Could not record paper note.',
          )
          return
        }
        setFlash(
          `Paper noted ${row.symbol} (${chainBadge(row.chain)}) — saved to DB, no trade sent.`,
        )
      } catch {
        setFlash('Could not record paper note (DB). Observe list is unchanged.')
      }
    },
    [disabledTip, paper, paperAllowed],
  )

  const solDelay = scout.data?.solDelayMin ?? 15
  const rhCount = scout.data?.counts.rh ?? 0
  const solCount = scout.data?.counts.sol ?? 0

  return (
    <section
      className="rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-3 space-y-3"
      aria-label="data-public observe strip"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Observe · data-public</h3>
          <p className="text-[11px] text-gray-400 leading-snug mt-0.5">
            {DATA_PUBLIC_STUDY_DISCLAIMER}
          </p>
          <p className="text-[11px] text-amber-200/80 mt-1">
            Sol feed delayed ≥{solDelay}m (staleness). Same paper mode on RH + Sol.
            Never live-executes from this strip.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
              climateLabel === 'Safe'
                ? 'border-emerald-400/35 bg-emerald-500/10 text-emerald-200'
                : climateLabel === 'Not safe'
                  ? 'border-amber-400/50 bg-amber-500/15 text-amber-200'
                  : 'border-white/20 bg-white/5 text-gray-400'
            }`}
            title="Paper notes follow the Header climate display label. Live trade controls stay ungated."
          >
            Climate {climateLabel}
          </span>
          <span className="text-[10px] text-gray-500">
            {rhCount} RH · {solCount} Sol
          </span>
        </div>
      </div>

      <div className="flex gap-1" role="tablist" aria-label="Observe chain">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-2.5 py-1 text-xs ${
              tab === t.id
                ? 'bg-white/10 text-white'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {scout.isError ? (
        <p className="text-xs text-amber-300">
          Observe feed unavailable. {scout.error instanceof Error ? scout.error.message : ''}
        </p>
      ) : scout.isPending ? (
        <p className="text-xs text-gray-500">Loading observe candidates…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-500">
          No filtered candidates{tab === 'solana' ? ' on Sol (feed is delayed)' : ''}.
        </p>
      ) : (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
          {rows.map((row) => {
            const key = `${row.chain}:${row.mint.toLowerCase()}`
            const noted = notedKeys.has(key)
            return (
              <li
                key={`${row.chain}-${row.id}-${row.mint}`}
                className="flex items-center gap-2 rounded-lg border border-gray-700/80 bg-gray-900/50 px-2 py-1.5"
              >
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    row.chain === 'robinhood'
                      ? 'bg-purple-500/15 text-purple-200'
                      : 'bg-sky-500/15 text-sky-200'
                  }`}
                >
                  {chainBadge(row.chain)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <button
                      type="button"
                      className="truncate text-xs font-medium text-white hover:underline"
                      onClick={() => onInspectMint?.(row.mint)}
                      title="Inspect in buy form (does not buy)"
                    >
                      {row.symbol}
                    </button>
                    <span className="truncate text-[10px] text-gray-500">{row.name}</span>
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {row.decision ?? row.kind}
                    {' · '}liq {formatUsd(row.liq)}
                    {' · '}mcap {formatUsd(row.mcap)}
                    {row.score != null ? ` · ${row.score}` : ''}
                  </div>
                </div>
                {row.url ? (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-[10px] text-gray-400 hover:text-gray-200"
                  >
                    Dex
                  </a>
                ) : (
                  <Link
                    href={tokenSearchDetailHref(row.mint)}
                    className="shrink-0 text-[10px] text-gray-400 hover:text-gray-200"
                  >
                    Map
                  </Link>
                )}
                <button
                  type="button"
                  disabled={!paperAllowed || noted || paper.noting}
                  title={
                    noted
                      ? 'Already paper-noted'
                      : paperAllowed
                        ? 'Record paper interest in DB. Does not execute a trade.'
                        : disabledTip
                  }
                  onClick={() => void onPaperNote(row)}
                  className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold ${
                    noted
                      ? 'cursor-default border border-emerald-400/20 text-emerald-300/70'
                      : paperAllowed
                        ? 'border border-emerald-400/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20'
                        : 'cursor-not-allowed border border-white/10 text-gray-500'
                  }`}
                >
                  {noted ? 'Noted' : 'Paper note'}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {flash ? <p className="text-[11px] text-gray-300">{flash}</p> : null}

      {paper.notches.length > 0 ? (
        <div className="border-t border-gray-700/80 pt-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
            Paper notes (DB, no fills)
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {paper.notches.slice(0, 12).map((n) => (
              <li
                key={n.key}
                className="rounded-md border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-300"
              >
                {chainBadge(n.chain)} {n.symbol}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
