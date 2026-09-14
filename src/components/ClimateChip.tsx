'use client';

import { useClimateDisplay, type ClimateChipLabel } from '@/hooks/useClimateDisplay';
import {
  climateChipHeadline,
  climateChipSubtitle,
  climateChipTip,
} from '@/utils/climateChipCopy';

const CHIP_CLASS: Record<ClimateChipLabel, string> = {
  Safe: 'border-emerald-400/20 bg-emerald-500/5 text-emerald-300/80',
  'Not safe': 'border-amber-500/70 bg-amber-500/20 text-amber-100',
  Unknown: 'border-white/10 bg-transparent text-gray-500',
};

export default function ClimateChip() {
  const { data, isPending, isError } = useClimateDisplay();
  const label: ClimateChipLabel =
    isError || !data ? 'Unknown' : data.label;
  const headline = climateChipHeadline(label);
  const subtitle = climateChipSubtitle({
    label,
    state: data?.state,
    h: data?.h,
  });
  const tip = climateChipTip({
    label,
    state: data?.state,
    cascadeVeto: data?.cascadeVeto,
  });
  const weight =
    label === 'Not safe' ? 'font-semibold' : 'font-medium';

  return (
    <div
      className={`flex shrink-0 max-w-[7.5rem] flex-col items-end rounded-full border px-2 py-0.5 leading-tight md:max-w-none md:px-3 md:py-1 ${CHIP_CLASS[label]} ${
        isPending ? 'opacity-70' : ''
      }`}
      title={tip}
      role="status"
      aria-live="polite"
      aria-label={tip}
    >
      <span className={`whitespace-nowrap text-[10px] md:text-xs ${weight}`}>
        {headline}
      </span>
      {subtitle ? (
        <span className="hidden whitespace-nowrap text-[9px] opacity-60 sm:block md:text-[10px]">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}
