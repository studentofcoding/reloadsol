'use client'

import { useCallback, useEffect, useState } from 'react'

type NoulShadowBand =
  | 'suppress'
  | 'mid'
  | 'keep'
  | 'skipped_null'
  | 'api_miss'

type NoulFilterReason = 'null_ml' | 'mid' | 'suppress' | 'keep' | 'api_miss'
type NoulShadowDecision = 'keep' | 'suppress' | 'follow_spec'
type NoulSpecDecision = 'keep' | 'suppress'
type FlipArmFamily = 'first_seen' | 'at_80'

type FlipBarCheck = {
  nOk: boolean
  agreementOk: boolean
  midOk: boolean
  missOk: boolean
  ready: boolean
}

type KillSwitchCheck = {
  apiMissRate: number | null
  disagreementRate: number | null
  apiMissSpike: boolean
  disagreementSpike: boolean
  tripped: boolean
}

type StrategyStats = {
  strategyKey: string
  total: number
  midBand: number
  midBandRate: number | null
  agreementEligible: number
  agreementMatches: number
  agreementRate: number | null
}

type FlipArmStats = {
  arm: FlipArmFamily | 'all'
  total: number
  midBand: number
  midBandRate: number | null
  apiMiss: number
  apiMissRate: number | null
  total24h: number
  apiMiss24h: number
  apiMissRate24h: number | null
  agreementEligible: number
  agreementMatches: number
  agreementRate: number | null
  bars: FlipBarCheck
  kill: KillSwitchCheck
}

type FlipStrategyStats = StrategyStats & {
  arm: FlipArmFamily | null
  apiMiss: number
  apiMissRate: number | null
  apiMissRate24h: number | null
  bars: FlipBarCheck
  kill: KillSwitchCheck
}

type FlipReadiness = {
  bars: { nMin: number; agreementMin: number; midMax: number }
  kill?: { apiMissMax: number; disagreementMax: number; minN: number }
  overall: FlipArmStats
  byArm: FlipArmStats[]
  byStrategy: FlipStrategyStats[]
}

type ShadowListRow = {
  id: number
  predictedAt: string
  tokenAddress: string
  symbol: string | null
  chain: string
  strategyKey: string
  clMlScore: number | null
  specWouldPass: boolean
  noulCalled: boolean
  noul: number | null
  band: NoulShadowBand
  filterReason: NoulFilterReason
  decisionShadow: NoulShadowDecision
  decisionSpec: NoulSpecDecision
}

const STRATEGY_KEYS = [
  'mcap_enter_first_seen',
  'mcap_enter_at_80',
  'mcap_enter_first_seen_rh',
  'mcap_enter_at_80_rh',
] as const

type ApiResponse = {
  success: boolean
  hours?: number
  shadowEnabled?: boolean
  softActive?: boolean
  hasTypeSafeCreds?: boolean
  total?: number
  byStrategy?: StrategyStats[]
  flipReadiness?: FlipReadiness
  rows?: ShadowListRow[]
  rowsTotal?: number
  limit?: number
  offset?: number
  strategyKey?: string | null
  arm?: FlipArmFamily | null
  band?: NoulShadowBand | null
  error?: string
}

type Props = {
  onNotify?: (kind: 'success' | 'error', title: string, detail?: string) => void
}

const BANDS: NoulShadowBand[] = [
  'keep',
  'suppress',
  'mid',
  'api_miss',
  'skipped_null',
]

const PAGE_SIZE = 100

function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function score(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(3)
}

function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function bandChipClass(band: NoulShadowBand): string {
  switch (band) {
    case 'keep':
      return 'bg-emerald-900/70 text-emerald-200'
    case 'suppress':
      return 'bg-rose-900/70 text-rose-200'
    case 'mid':
      return 'bg-amber-900/60 text-amber-200'
    case 'api_miss':
      return 'bg-orange-900/60 text-orange-200'
    case 'skipped_null':
      return 'bg-gray-800 text-gray-400'
    default:
      return 'bg-gray-800 text-gray-300'
  }
}

function reasonChipClass(reason: NoulFilterReason): string {
  switch (reason) {
    case 'keep':
      return 'bg-emerald-900/70 text-emerald-200'
    case 'suppress':
      return 'bg-rose-900/70 text-rose-200'
    case 'mid':
      return 'bg-amber-900/60 text-amber-200'
    case 'api_miss':
      return 'bg-orange-900/60 text-orange-200'
    case 'null_ml':
      return 'bg-gray-800 text-gray-400'
    default:
      return 'bg-gray-800 text-gray-300'
  }
}

function decisionChipClass(d: string): string {
  if (d === 'keep') return 'bg-emerald-900/50 text-emerald-200'
  if (d === 'suppress') return 'bg-rose-900/50 text-rose-200'
  if (d === 'follow_spec') return 'bg-sky-900/50 text-sky-200'
  return 'bg-slate-800 text-slate-300'
}

function Chip({
  label,
  className,
}: {
  label: string
  className: string
}) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${className}`}
    >
      {label}
    </span>
  )
}

function BarMeter({
  label,
  valueLabel,
  ok,
  fill,
}: {
  label: string
  valueLabel: string
  ok: boolean
  /** 0–1 progress toward bar (clamped). */
  fill: number
}) {
  const width = Math.max(0, Math.min(1, fill)) * 100
  return (
    <div className="space-y-1 min-w-[140px] flex-1">
      <div className="flex justify-between gap-2 text-[11px]">
        <span className="text-gray-400">{label}</span>
        <span className={ok ? 'text-emerald-300' : 'text-amber-200'}>
          {valueLabel}
          {ok ? ' ✓' : ''}
        </span>
      </div>
      <div className="h-1.5 rounded bg-gray-800 overflow-hidden">
        <div
          className={`h-full ${ok ? 'bg-emerald-500' : 'bg-amber-500/80'}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  )
}

function FlipArmCard({
  title,
  subtitle,
  stats,
  bars,
  thresholds,
  apiMissMax,
}: {
  title: string
  subtitle?: string
  stats: {
    total: number
    agreementRate: number | null
    midBandRate: number | null
    agreementMatches: number
    agreementEligible: number
    midBand: number
    apiMiss: number
    apiMissRate: number | null
    apiMissRate24h: number | null
    kill: KillSwitchCheck
  }
  bars: FlipBarCheck
  thresholds: { nMin: number; agreementMin: number; midMax: number }
  apiMissMax?: number
}) {
  const { nMin, agreementMin: aMin, midMax: mMax } = thresholds
  const missMax = apiMissMax ?? 0.1
  const midDenom = Math.max(0, stats.total - stats.apiMiss)
  return (
    <div
      className={`rounded-lg border p-3 space-y-3 ${
        bars.ready
          ? 'border-emerald-800/80 bg-emerald-950/20'
          : 'border-gray-700 bg-gray-950/40'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-white">{title}</h4>
          {subtitle ? (
            <p className="text-[11px] text-gray-500 font-mono">{subtitle}</p>
          ) : null}
        </div>
        <Chip
          label={
            !bars.missOk
              ? 'miss kill'
              : bars.ready
                ? 'flip-ready'
                : 'shadow sample'
          }
          className={
            !bars.missOk
              ? 'bg-orange-900/70 text-orange-200'
              : bars.ready
                ? 'bg-emerald-900/70 text-emerald-200'
                : 'bg-sky-900/50 text-sky-200'
          }
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <BarMeter
          label={`N ≥ ${nMin}`}
          valueLabel={`${stats.total}`}
          ok={bars.nOk}
          fill={stats.total / nMin}
        />
        <BarMeter
          label={`A ≥ ${(aMin * 100).toFixed(0)}%`}
          valueLabel={
            stats.agreementRate == null
              ? '—'
              : `${pct(stats.agreementRate)} (${stats.agreementMatches}/${stats.agreementEligible})`
          }
          ok={bars.agreementOk}
          fill={stats.agreementRate == null ? 0 : stats.agreementRate / aMin}
        />
        <BarMeter
          label={`M ≤ ${(mMax * 100).toFixed(0)}%`}
          valueLabel={
            stats.midBandRate == null
              ? '—'
              : `${pct(stats.midBandRate)} (${stats.midBand}/${midDenom})`
          }
          ok={bars.midOk}
          fill={
            stats.midBandRate == null
              ? 0
              : stats.midBandRate <= mMax
                ? 1
                : Math.max(0, 1 - (stats.midBandRate - mMax) / mMax)
          }
        />
        <BarMeter
          label={`miss ≤ ${(missMax * 100).toFixed(0)}%`}
          valueLabel={
            stats.apiMissRate == null
              ? '—'
              : `${pct(stats.apiMissRate)} (${stats.apiMiss}/${stats.total})` +
                (stats.apiMissRate24h == null
                  ? ''
                  : ` · 24h ${pct(stats.apiMissRate24h)}`)
          }
          ok={bars.missOk}
          fill={
            stats.apiMissRate == null
              ? 0
              : stats.apiMissRate <= missMax
                ? stats.apiMissRate / missMax
                : 1
          }
        />
      </div>
    </div>
  )
}

function decisionsAgree(
  shadow: NoulShadowDecision,
  spec: NoulSpecDecision,
): boolean | null {
  if (shadow === 'follow_spec') return null
  return shadow === spec
}

export default function EarlyEnterNoulShadowPanel({ onNotify }: Props) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [hours, setHours] = useState(24)
  const [arm, setArm] = useState<'' | FlipArmFamily>('')
  const [strategyKey, setStrategyKey] = useState('')
  const [band, setBand] = useState('')
  const [offset, setOffset] = useState(0)

  const load = useCallback(
    async (nextOffset: number) => {
      setLoading(true)
      try {
        const q = new URLSearchParams()
        q.set('hours', String(hours))
        q.set('limit', String(PAGE_SIZE))
        q.set('offset', String(nextOffset))
        if (arm) q.set('arm', arm)
        if (strategyKey) q.set('strategy_key', strategyKey)
        if (band) q.set('band', band)
        const res = await fetch(
          `/api/strategies/ml/early-enter-noul-shadow?${q.toString()}`,
        )
        const json = (await res.json()) as ApiResponse
        if (!json.success) throw new Error(json.error ?? 'load failed')
        setData(json)
        setOffset(nextOffset)
      } catch (e) {
        onNotify?.(
          'error',
          'Noul shadow stats failed',
          e instanceof Error ? e.message : String(e),
        )
      } finally {
        setLoading(false)
      }
    },
    [onNotify, hours, arm, strategyKey, band],
  )

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load(0)
    }, 0)
    return () => window.clearTimeout(t)
  }, [load])

  const flip = data?.flipReadiness
  const funnelRows = data?.rows ?? []
  const rowsTotal = data?.rowsTotal ?? 0
  const showingFrom = rowsTotal === 0 ? 0 : offset + 1
  const showingTo = Math.min(offset + PAGE_SIZE, rowsTotal)

  const firstSeen = flip?.byArm.find((a) => a.arm === 'first_seen')
  const at80 = flip?.byArm.find((a) => a.arm === 'at_80')
  const flipThresholds = flip?.bars ?? {
    nMin: 500,
    agreementMin: 0.85,
    midMax: 0.2,
  }

  const strategyOptions =
    arm === 'first_seen'
      ? STRATEGY_KEYS.filter((k) => k.includes('first_seen'))
      : arm === 'at_80'
        ? STRATEGY_KEYS.filter((k) => k.includes('at_80'))
        : STRATEGY_KEYS

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Early Enter Noul shadow</h2>
          <p className="text-gray-400 text-sm">
            Shadow funnel + #54 flip-readiness (n / agree / mid / miss).
            api_miss is soft-fail and follows SPEC. It is left out of agreement
            and mid-rate. miss% too high blocks flip. miss is not suppress
            disagreement. Soft-active stays off. Paper is never flipped.
          </p>
        </div>
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            data?.shadowEnabled === false
              ? 'bg-gray-800 text-gray-400'
              : 'bg-sky-900/60 text-sky-200'
          }`}
        >
          {data?.shadowEnabled === false ? 'shadow off' : 'shadow'}
        </span>
      </div>

      {loading && !data ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : (
        <p className="text-xs text-gray-500">
          EARLY_ENTER_NOUL_SHADOW={data?.shadowEnabled ? '1' : '0'} · soft-active{' '}
          {data?.softActive ? 'on' : 'off'} · TYPESAFE=
          {data?.hasTypeSafeCreds ? 'set' : 'missing'} · all-time N{' '}
          {flip?.overall.total ?? 0}
          {flip?.overall.bars?.missOk === false ? ' · miss kill' : ''} · window rows{' '}
          {data?.total ?? 0}
        </p>
      )}

      {/* #54 flip-readiness — split by arm */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">
            Flip readiness (#54)
          </h3>
          <p className="text-[11px] text-gray-500">
            n / agree / mid / miss · N≥{flip?.bars.nMin ?? 500} · A≥
            {((flip?.bars.agreementMin ?? 0.85) * 100).toFixed(0)}% (keep/suppress
            only) · M≤{((flip?.bars.midMax ?? 0.2) * 100).toFixed(0)}% (excludes
            api_miss) · miss% &gt;{((flip?.kill?.apiMissMax ?? 0.1) * 100).toFixed(0)}%
            blocks flip (all-time, or 24h when N≥{flip?.kill?.minN ?? 20})
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {firstSeen ? (
            <FlipArmCard
              title="first_seen"
              subtitle="mcap_enter_first_seen · _rh"
              stats={firstSeen}
              bars={firstSeen.bars}
              thresholds={flipThresholds}
              apiMissMax={flip?.kill?.apiMissMax}
            />
          ) : null}
          {at80 ? (
            <FlipArmCard
              title="at_80"
              subtitle="mcap_enter_at_80 · _rh"
              stats={at80}
              bars={at80.bars}
              thresholds={flipThresholds}
              apiMissMax={flip?.kill?.apiMissMax}
            />
          ) : null}
        </div>
        {flip?.byStrategy && flip.byStrategy.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-gray-400 border-b border-gray-700">
                <tr>
                  <th className="py-2 pr-3 font-medium">strategy_key</th>
                  <th className="py-2 pr-3 font-medium">arm</th>
                  <th className="py-2 pr-3 font-medium">n</th>
                  <th className="py-2 pr-3 font-medium">agreement</th>
                  <th className="py-2 pr-3 font-medium">mid-rate</th>
                  <th className="py-2 pr-3 font-medium">miss</th>
                  <th className="py-2 pr-3 font-medium">bars</th>
                </tr>
              </thead>
              <tbody className="text-gray-200">
                {flip.byStrategy.map((r) => (
                  <tr key={r.strategyKey} className="border-b border-gray-800">
                    <td className="py-2 pr-3 font-mono text-xs">{r.strategyKey}</td>
                    <td className="py-2 pr-3 text-xs text-gray-400">
                      {r.arm ?? '—'}
                    </td>
                    <td className="py-2 pr-3">{r.total}</td>
                    <td className="py-2 pr-3">
                      {pct(r.agreementRate)}
                      <span className="text-gray-500 text-xs ml-1">
                        ({r.agreementMatches}/{r.agreementEligible})
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {pct(r.midBandRate)}
                      <span className="text-gray-500 text-xs ml-1">
                        ({r.midBand}/{Math.max(0, r.total - r.apiMiss)})
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {pct(r.apiMissRate)}
                      <span className="text-gray-500 text-xs ml-1">
                        ({r.apiMiss}/{r.total})
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <Chip
                        label={
                          r.bars.ready
                            ? 'ready'
                            : [
                                r.bars.nOk ? null : 'N',
                                r.bars.agreementOk ? null : 'A',
                                r.bars.midOk ? null : 'M',
                                r.bars.missOk ? null : 'miss',
                              ]
                                .filter(Boolean)
                                .join('/') || '—'
                        }
                        className={
                          r.bars.ready
                            ? 'bg-emerald-900/60 text-emerald-200'
                            : 'bg-amber-900/50 text-amber-200'
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No all-time shadow sample yet.</p>
        )}
      </div>

      <div className="border-t border-gray-800 pt-4 space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-gray-400 flex flex-col gap-1">
            Arm
            <select
              value={arm}
              onChange={(e) => {
                setArm(e.target.value as '' | FlipArmFamily)
                setStrategyKey('')
              }}
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5"
            >
              <option value="">All</option>
              <option value="first_seen">first_seen</option>
              <option value="at_80">at_80</option>
            </select>
          </label>
          <label className="text-xs text-gray-400 flex flex-col gap-1">
            Hours
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5"
            >
              <option value={6}>6</option>
              <option value={24}>24</option>
              <option value={48}>48</option>
              <option value={168}>168</option>
            </select>
          </label>
          <label className="text-xs text-gray-400 flex flex-col gap-1">
            strategy_key
            <select
              value={strategyKey}
              onChange={(e) => setStrategyKey(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5 max-w-[220px]"
            >
              <option value="">All</option>
              {strategyOptions.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-400 flex flex-col gap-1">
            band
            <select
              value={band}
              onChange={(e) => setBand(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1.5"
            >
              <option value="">All</option>
              {BANDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(offset)}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
          >
            Reload
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white">Token funnel</h3>
          <p className="text-xs text-gray-500">
            {rowsTotal === 0
              ? 'No rows'
              : `Showing ${showingFrom}–${showingTo} of ${rowsTotal}`}
          </p>
        </div>

        {funnelRows.length === 0 ? (
          <p className="text-gray-500 text-sm">
            No shadowed tokens for this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left min-w-[900px]">
              <thead className="text-xs text-gray-400 border-b border-gray-700">
                <tr>
                  <th className="py-2 pr-2 font-medium">when</th>
                  <th className="py-2 pr-2 font-medium">token</th>
                  <th className="py-2 pr-2 font-medium">strategy_key</th>
                  <th className="py-2 pr-2 font-medium">spec_would_pass</th>
                  <th className="py-2 pr-2 font-medium">noul_called</th>
                  <th className="py-2 pr-2 font-medium">band</th>
                  <th className="py-2 pr-2 font-medium">filter reason</th>
                  <th className="py-2 pr-2 font-medium">shadow vs SPEC</th>
                  <th className="py-2 pr-2 font-medium">noul</th>
                </tr>
              </thead>
              <tbody className="text-gray-200">
                {funnelRows.map((r) => {
                  const agree = decisionsAgree(r.decisionShadow, r.decisionSpec)
                  return (
                    <tr key={r.id} className="border-b border-gray-800 align-top">
                      <td className="py-2 pr-2 text-xs text-gray-400 whitespace-nowrap">
                        {formatWhen(r.predictedAt)}
                      </td>
                      <td className="py-2 pr-2">
                        <div className="font-medium text-white text-xs">
                          {r.symbol || '—'}
                        </div>
                        <div
                          className="font-mono text-[11px] text-gray-500"
                          title={r.tokenAddress}
                        >
                          {shortAddr(r.tokenAddress)}
                          <span className="ml-1 text-gray-600">{r.chain}</span>
                        </div>
                      </td>
                      <td
                        className="py-2 pr-2 font-mono text-[11px] max-w-[160px] truncate"
                        title={r.strategyKey}
                      >
                        {r.strategyKey}
                      </td>
                      <td className="py-2 pr-2">
                        <Chip
                          label={r.specWouldPass ? 'true' : 'false'}
                          className={
                            r.specWouldPass
                              ? 'bg-emerald-900/50 text-emerald-200'
                              : 'bg-gray-800 text-gray-400'
                          }
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Chip
                          label={r.noulCalled ? 'true' : 'false'}
                          className={
                            r.noulCalled
                              ? 'bg-sky-900/50 text-sky-200'
                              : 'bg-gray-800 text-gray-500'
                          }
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <Chip label={r.band} className={bandChipClass(r.band)} />
                      </td>
                      <td className="py-2 pr-2">
                        <Chip
                          label={r.filterReason}
                          className={reasonChipClass(r.filterReason)}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex flex-wrap items-center gap-1">
                          <Chip
                            label={r.decisionShadow}
                            className={decisionChipClass(r.decisionShadow)}
                          />
                          <span className="text-gray-600 text-[11px]">vs</span>
                          <Chip
                            label={r.decisionSpec}
                            className={decisionChipClass(r.decisionSpec)}
                          />
                          {agree === true ? (
                            <span className="text-emerald-400 text-[11px]">agree</span>
                          ) : agree === false ? (
                            <span className="text-rose-400 text-[11px]">diff</span>
                          ) : (
                            <span className="text-sky-400 text-[11px]">follow</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-2 font-mono text-xs text-gray-400">
                        {r.noulCalled ? score(r.noul) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading || offset <= 0}
            onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
          >
            Prev
          </button>
          <button
            type="button"
            disabled={loading || offset + PAGE_SIZE >= rowsTotal}
            onClick={() => void load(offset + PAGE_SIZE)}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
          >
            Next
          </button>
        </div>
      </div>
    </section>
  )
}
