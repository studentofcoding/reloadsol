'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useClimateDisplay, type ClimateChipLabel } from '@/hooks/useClimateDisplay';
import {
  formatClimateRegimeDetail,
  formatClimateRegimeTooltip,
} from '@/utils/climateDisplay';
import LiveNumber, { LIVE_NUMBER_H } from '@/components/insight/LiveNumber';

const CHIP_TONE_LIGHT: Record<ClimateChipLabel, string> = {
  Safe: 'bg-emerald-600/15 text-emerald-800 shadow-[0_0_0_1px_rgba(6,95,70,0.22)]',
  'Not safe': 'bg-amber-500/20 text-amber-900 shadow-[0_0_0_1px_rgba(146,64,14,0.28)]',
  Unknown: 'bg-black/[0.05] text-neutral-600 shadow-[0_0_0_1px_rgba(0,0,0,0.08)]',
};

const CHIP_TONE_DARK: Record<ClimateChipLabel, string> = {
  Safe: 'bg-emerald-500/10 text-emerald-200 shadow-[0_0_0_1px_oklch(0.76_0.14_155_/_0.35)]',
  'Not safe': 'bg-amber-500/15 text-amber-200 shadow-[0_0_0_1px_oklch(0.84_0.14_75_/_0.5)]',
  Unknown: 'bg-white/5 text-gray-400 shadow-elev',
};

function climateState(label: ClimateChipLabel) {
  if (label === 'Safe') return 'safe'
  if (label === 'Not safe') return 'not-safe'
  return 'unknown'
}

function ClimateDot({ label }: { label: ClimateChipLabel }) {
  const filled = label !== 'Unknown';
  return (
    <span data-slot="climate-chip-dot" className="mt-0.5 inline-flex size-1.5 shrink-0" aria-hidden>
      <span
        className={`block size-1.5 rounded-full ${
          filled ? 'bg-current' : 'bg-transparent shadow-[0_0_0_1px_currentColor]'
        }`}
      />
    </span>
  );
}

/** Live headline (or fallback state · H) under the binary climate label. */
export function ClimateRegimeLiveDetail({
  headline,
  state,
  h,
}: {
  headline?: string | null
  state?: string | null
  h?: number | null
}): ReactNode {
  const headlineLabel = typeof headline === 'string' && headline.trim() ? headline.trim() : null
  if (headlineLabel) return headlineLabel
  const stateLabel = typeof state === 'string' && state.trim() ? state.trim() : null
  const hasH = typeof h === 'number' && Number.isFinite(h)
  if (!stateLabel && !hasH) return null
  return (
    <>
      {stateLabel}
      {stateLabel && hasH ? ' · ' : null}
      {hasH ? (
        <LiveNumber
          value={h}
          format={LIVE_NUMBER_H}
          prefix="H "
          aria-hidden
        />
      ) : null}
    </>
  )
}

export function ClimateChipView({
  label,
  subtitle,
  isPending = false,
  title,
  ariaLabel,
  layout = 'header',
}: {
  label: ClimateChipLabel
  subtitle: ReactNode
  isPending?: boolean
  title?: string
  ariaLabel?: string
  layout?: 'header' | 'inline'
}) {
  const compact = layout === 'header'
  const tone = compact ? CHIP_TONE_LIGHT : CHIP_TONE_DARK
  const prevLabel = useRef(label)
  const [pop, setPop] = useState(false)

  useEffect(() => {
    if (prevLabel.current === label) return
    prevLabel.current = label
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return
    }
    const kick = window.requestAnimationFrame(() => setPop(true))
    const timer = window.setTimeout(() => setPop(false), 180)
    return () => {
      window.cancelAnimationFrame(kick)
      window.clearTimeout(timer)
    }
  }, [label])

  return (
    <div
      data-slot="climate-chip"
      data-state={climateState(label)}
      data-pop={pop ? 'true' : 'false'}
      className={`flex shrink-0 items-start gap-1.5 rounded-full px-2 py-0.5 leading-tight md:px-2.5 md:py-1 ${
        compact ? 'max-w-[12.5rem] md:max-w-none' : ''
      } ${tone[label]} ${isPending ? 'opacity-70' : 'opacity-100'}`}
      title={title}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel ?? label}
    >
      <ClimateDot label={label} />
      <span className="flex min-w-0 flex-col items-start">
        <span
          data-slot="climate-chip-label"
          className="whitespace-nowrap text-[10px] font-semibold tracking-[0.02em] md:text-xs md:tracking-normal"
        >
          {label}
        </span>
        {subtitle ? (
          <span
            data-slot="climate-chip-detail"
            className={`max-w-full truncate text-[9px] tracking-[0.01em] opacity-75 md:text-[10px] ${
              compact ? 'hidden sm:block' : ''
            }`}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </div>
  )
}

export default function ClimateChip() {
  const { data, isPending, isError } = useClimateDisplay();
  const label: ClimateChipLabel =
    isError || !data ? 'Unknown' : data.label;
  const subtitleText = formatClimateRegimeDetail({
    headline: data?.headline,
    state: data?.state,
    h: data?.h,
  });
  const subtitle = subtitleText ? (
    <ClimateRegimeLiveDetail
      headline={data?.headline}
      state={data?.state}
      h={data?.h}
    />
  ) : null;
  const tip = formatClimateRegimeTooltip({
    label,
    headline: data?.headline,
    detail: data?.detail,
    state: data?.state,
    h: data?.h,
  });

  return (
    <ClimateChipView
      label={label}
      subtitle={subtitle}
      isPending={isPending}
      title={tip}
      ariaLabel={subtitleText ? `${label}, ${subtitleText}` : label}
    />
  );
}
