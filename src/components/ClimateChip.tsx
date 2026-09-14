'use client';

import { useClimateDisplay, type ClimateChipLabel } from '@/hooks/useClimateDisplay';

const CHIP_CLASS: Record<ClimateChipLabel, string> = {
  Safe: 'border-emerald-400/35 bg-emerald-500/10 text-emerald-200',
  'Not safe': 'border-amber-400/50 bg-amber-500/15 text-amber-200',
  Unknown: 'border-white/20 bg-white/5 text-gray-400',
};

function formatH(h: number | null | undefined): string | null {
  if (typeof h !== 'number' || !Number.isFinite(h)) return null;
  return `H ${h.toFixed(2)}`;
}

export default function ClimateChip() {
  const { data, isPending, isError } = useClimateDisplay();
  const label: ClimateChipLabel =
    isError || !data ? 'Unknown' : data.label;
  const state = data?.state ?? undefined;
  const hLabel = formatH(data?.h);
  const subtitle = [state, hLabel].filter(Boolean).join(' · ');
  const tip =
    label === 'Unknown'
      ? 'Regime climate unknown (fetch failed or stale). Display only — does not block trades.'
      : label === 'Not safe'
        ? `Regime climate: Not safe${subtitle ? ` (${subtitle})` : ''}. Display only — does not block trades.`
        : `Regime climate: Safe${subtitle ? ` (${subtitle})` : ''}. Display only.`;

  return (
    <div
      className={`flex shrink-0 max-w-[7.5rem] flex-col items-end rounded-full border px-2 py-0.5 leading-tight md:max-w-none md:px-3 md:py-1 ${CHIP_CLASS[label]} ${
        isPending ? 'opacity-70' : ''
      }`}
      title={tip}
      role="status"
      aria-live="polite"
      aria-label={`Regime climate: ${label}`}
    >
      <span className="whitespace-nowrap text-[10px] font-semibold md:text-xs">
        {label}
      </span>
      {subtitle ? (
        <span className="hidden whitespace-nowrap text-[9px] opacity-70 sm:block md:text-[10px]">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}
