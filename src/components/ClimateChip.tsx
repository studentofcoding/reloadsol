'use client';

import type { ReactNode } from 'react';
import { useClimateDisplay, type ClimateChipLabel } from '@/hooks/useClimateDisplay';
import { formatClimateRegimeDetail } from '@/utils/climateDisplay';
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

function ClimateDot({ label }: { label: ClimateChipLabel }) {
  const filled = label !== 'Unknown';
  return (
    <span className="mt-0.5 inline-flex size-1.5 shrink-0" aria-hidden>
      <span
        className={`block size-1.5 rounded-full ${
          filled ? 'bg-current' : 'bg-transparent shadow-[0_0_0_1px_currentColor]'
        }`}
      />
    </span>
  );
}

/** Live H (and optional state) under the binary climate label. */
export function ClimateRegimeLiveDetail({
  state,
  h,
}: {
  state?: string | null
  h?: number | null
}): ReactNode {
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
  return (
    <div
      className={`flex shrink-0 items-start gap-1.5 rounded-full px-2 py-0.5 leading-tight md:px-2.5 md:py-1 ${
        compact ? 'max-w-[7.5rem] md:max-w-none' : ''
      } ${tone[label]} ${
        isPending ? 'opacity-70' : 'opacity-100'
      } transition-[opacity,box-shadow,background-color,color] duration-150 ease-out-strong motion-reduce:transition-[opacity,background-color,color]`}
      title={title}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel ?? label}
    >
      <ClimateDot label={label} />
      <span className="flex min-w-0 flex-col items-start">
        <span className="whitespace-nowrap text-[10px] font-semibold tracking-[0.02em] md:text-xs md:tracking-normal">
          {label}
        </span>
        {subtitle ? (
          <span
            className={`whitespace-nowrap text-[9px] tabular-nums tracking-[0.01em] opacity-75 md:text-[10px] ${
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
    state: data?.state,
    h: data?.h,
  });
  const subtitle = subtitleText ? (
    <ClimateRegimeLiveDetail state={data?.state} h={data?.h} />
  ) : null;
  const tip =
    label === 'Unknown'
      ? 'Regime climate unknown (fetch failed or stale). Display only — does not block trades.'
      : label === 'Not safe'
        ? `Not safe${subtitleText ? ` (${subtitleText})` : ''}. Display only — does not block trades.`
        : `Safe${subtitleText ? ` (${subtitleText})` : ''}. Display only.`;

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
