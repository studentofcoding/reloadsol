'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { ClimateChipView, ClimateRegimeLiveDetail } from '@/components/ClimateChip'
import LiveNumber, {
  LIVE_NUMBER_COMPACT_USD,
  LIVE_NUMBER_COUNT,
  LIVE_NUMBER_SCORE,
} from '@/components/insight/LiveNumber'
import { BookmarkFill, BookmarkOutline } from '@/components/insight/InsightIcons'
import InsightPressButton from '@/components/insight/InsightPressButton'
import {
  insightCard,
  insightPressQuiet,
  insightRow,
} from '@/components/insight/insight-ui'
import { useClimateDisplay } from '@/hooks/useClimateDisplay'
import { useDataPublicScout } from '@/hooks/useDataPublicScout'
import { useBuybulkPaperNotches } from '@/hooks/useBuybulkPaperNotches'
import { tokenSearchDetailHref } from '@/components/signals/shared/token-search-href'
import {
  formatClimateRegimeDetail,
  formatClimateRegimeTooltip,
} from '@/utils/climateDisplay'
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

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function chainBadge(chain: ScoutChain): string {
  return chain === 'robinhood' ? 'RH' : 'Sol'
}

function PaperNoteGlyph({ noted }: { noted: boolean }) {
  return (
    <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
      <span
        className={`insight-icon-swap absolute inset-0 flex items-center justify-center ${
          noted
            ? 'scale-100 opacity-100 blur-0'
            : 'scale-[0.25] opacity-0 blur-[4px] motion-reduce:scale-100'
        }`}
      >
        <BookmarkFill className="size-3.5" />
      </span>
      <span
        className={`insight-icon-swap flex items-center justify-center ${
          noted
            ? 'scale-[0.25] opacity-0 blur-[4px] motion-reduce:scale-100'
            : 'scale-100 opacity-100 blur-0'
        }`}
      >
        <BookmarkOutline className="size-3.5" />
      </span>
    </span>
  )
}

export default function DataPublicObserveStrip({
  chain,
  onInspectMint,
}: {
  /** Network-scoped BFF query (`robinhood` | `solana`). Same strategy id. */
  chain: ScoutChain
  onInspectMint?: (mint: string) => void
}) {
  const scout = useDataPublicScout(chain)
  const climate = useClimateDisplay()
  const cache = useMemo<PaperNotch[]>(
    () => readPaperNotchesFromStorage(storage()),
    [],
  )
  const paper = useBuybulkPaperNotches(cache)
  const [flash, setFlash] = useState<string | null>(null)

  const climateLabel = climate.data?.label ?? 'Unknown'
  const regimeDetail = formatClimateRegimeDetail({
    headline: climate.data?.headline,
    state: climate.data?.state,
    h: climate.data?.h,
  })
  const regimeLive = regimeDetail ? (
    <ClimateRegimeLiveDetail
      headline={climate.data?.headline}
      state={climate.data?.state}
      h={climate.data?.h}
    />
  ) : null
  const climateTip = formatClimateRegimeTooltip({
    label: climateLabel,
    headline: climate.data?.headline,
    detail: climate.data?.detail,
    state: climate.data?.state,
    h: climate.data?.h,
  })
  const paperAllowed = canPaperNotchFromClimate(climateLabel)
  const disabledTip = paperNotchDisabledTip(climateLabel)

  const rows = scout.data?.rows ?? []

  const notedKeys = useMemo(
    () =>
      new Set(
        paper.notches.filter((n) => n.chain === chain).map((n) => n.key),
      ),
    [chain, paper.notches],
  )
  const chainNotches = useMemo(
    () => paper.notches.filter((n) => n.chain === chain),
    [chain, paper.notches],
  )

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
  const chainCount =
    chain === 'robinhood' ? (scout.data?.counts.rh ?? 0) : (scout.data?.counts.sol ?? 0)
  const title = chain === 'robinhood' ? 'RH scout · data-public' : 'Sol scout · data-public'
  const climateAria = regimeDetail ? `${climateLabel}, ${regimeDetail}` : climateLabel

  return (
    <section
      className={`${insightCard} space-y-3`}
      aria-label={`${chain === 'robinhood' ? 'RH' : 'Sol'} data-public scout`}
    >
      <div className="flex flex-col gap-2 px-2 pt-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-400">
            {DATA_PUBLIC_STUDY_DISCLAIMER}
          </p>
          <p className="mt-1 text-[11px] text-amber-200/80">
            {chain === 'solana'
              ? `Sol feed delayed ≥${solDelay}m (staleness). Same paper mode as RH. Never live-executes from this list.`
              : 'Same paper mode as Sol. Never live-executes from this list.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ClimateChipView
            label={climateLabel}
            subtitle={regimeLive}
            isPending={climate.isPending}
            layout="inline"
            title={`${climateTip} Paper notes follow the Header climate display label. Live trade controls stay ungated.`}
            ariaLabel={climateAria}
          />
          <span className="text-[10px] tabular-nums text-gray-500">
            <LiveNumber value={chainCount} format={LIVE_NUMBER_COUNT} />{' '}
            {chainBadge(chain)}
          </span>
        </div>
      </div>

      {scout.isError ? (
        <p className="px-2 text-xs text-amber-300">
          Scout feed unavailable. {scout.error instanceof Error ? scout.error.message : ''}
        </p>
      ) : scout.isPending ? (
        <p className="px-2 text-xs text-gray-500">Loading scout candidates…</p>
      ) : rows.length === 0 ? (
        <p className="px-2 text-xs text-gray-500">
          No filtered candidates{chain === 'solana' ? ' on Sol (feed is delayed)' : ' on RH'}.
        </p>
      ) : (
        <ul className="max-h-[28rem] space-y-1.5 overflow-y-auto pr-1">
          {rows.map((row) => {
            const key = `${row.chain}:${row.mint.toLowerCase()}`
            const noted = notedKeys.has(key)
            return (
              <li
                key={`${row.chain}-${row.id}-${row.mint}`}
                className={`flex items-center gap-2 ${insightRow}`}
              >
                <span
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                    row.chain === 'robinhood'
                      ? 'bg-purple-500/15 text-purple-200'
                      : 'bg-sky-500/15 text-sky-200'
                  }`}
                >
                  {chainBadge(row.chain)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    {onInspectMint ? (
                      <button
                        type="button"
                        className={`truncate text-xs font-medium text-white ${insightPressQuiet} fine-hover:text-gray-100`}
                        onClick={() => onInspectMint(row.mint)}
                        title="Inspect in buy form (does not buy)"
                      >
                        {row.symbol}
                      </button>
                    ) : (
                      <Link
                        href={tokenSearchDetailHref(row.mint)}
                        className={`truncate text-xs font-medium text-white ${insightPressQuiet} fine-hover:text-gray-100`}
                        title="Open token map (does not buy)"
                      >
                        {row.symbol}
                      </Link>
                    )}
                    <span className="truncate text-[10px] text-gray-500">{row.name}</span>
                  </div>
                  <div className="text-[10px] tabular-nums text-gray-400">
                    {row.decision ?? row.kind}
                    {' · '}liq{' '}
                    <LiveNumber value={row.liq} format={LIVE_NUMBER_COMPACT_USD} />
                    {' · '}mcap{' '}
                    <LiveNumber value={row.mcap} format={LIVE_NUMBER_COMPACT_USD} />
                    {row.score != null ? (
                      <>
                        {' · '}
                        <LiveNumber value={row.score} format={LIVE_NUMBER_SCORE} />
                      </>
                    ) : null}
                  </div>
                </div>
                {row.url ? (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`shrink-0 text-[10px] text-gray-400 ${insightPressQuiet} fine-hover:text-gray-200`}
                  >
                    Dex
                  </a>
                ) : (
                  <Link
                    href={tokenSearchDetailHref(row.mint)}
                    className={`shrink-0 text-[10px] text-gray-400 ${insightPressQuiet} fine-hover:text-gray-200`}
                  >
                    Map
                  </Link>
                )}
                <InsightPressButton
                  quiet={noted || !paperAllowed}
                  disabled={!paperAllowed || noted || paper.noting}
                  title={
                    noted
                      ? 'Already paper-noted'
                      : paperAllowed
                        ? 'Record paper interest in DB. Does not execute a trade.'
                        : disabledTip
                  }
                  onClick={() => void onPaperNote(row)}
                  className={`inline-flex shrink-0 items-center gap-1 rounded-lg py-1 ps-1.5 pe-2 text-[10px] font-semibold ${
                    noted
                      ? 'cursor-default text-emerald-300/70 shadow-elev'
                      : paperAllowed
                        ? 'bg-emerald-500/10 text-emerald-100 shadow-elev fine-hover:bg-emerald-500/20'
                        : 'cursor-not-allowed text-gray-500 shadow-elev'
                  }`}
                >
                  <PaperNoteGlyph noted={noted} />
                  {noted ? 'Noted' : 'Paper note'}
                </InsightPressButton>
              </li>
            )
          })}
        </ul>
      )}

      {flash ? <p className="insight-flash px-2 text-[11px] text-gray-300">{flash}</p> : null}

      {chainNotches.length > 0 ? (
        <div className="border-t border-white/10 px-2 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">
            Paper notes (DB, no fills)
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {chainNotches.slice(0, 12).map((n) => (
              <li
                key={n.key}
                className="rounded-lg px-1.5 py-0.5 text-[10px] text-gray-300 shadow-elev"
              >
                {chainBadge(n.chain)} {n.symbol}
                {n.score != null ? (
                  <>
                    {' '}
                    <LiveNumber value={n.score} format={LIVE_NUMBER_SCORE} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
