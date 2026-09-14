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
  const fullHeadline = climateChipHeadline(label, 'full');
  const compactHeadline = climateChipHeadline(label, 'compact');
  const subtitle = climateChipSubtitle({
    label,
    state: data?.state,
    h: data?.h,
  });
  const tip = climateChipTip({
    label,
    state: data?.state,
    h: data?.h,
    cascadeVeto: data?.cascadeVeto,
    sizeKind: data?.sizeKind,
    scale: data?.scale,
    reason: data?.reason,
  });
  const weight =
    label === 'Not safe' ? 'font-semibold' : 'font-medium';
  const notSafe = label === 'Not safe';

  return (
    <div
      className={`flex shrink-0 flex-col items-end rounded-full border px-2 py-0.5 leading-tight md:px-3 md:py-1 ${
        notSafe ? 'max-w-[6.5rem] md:max-w-[18rem]' : 'max-w-[7.5rem] md:max-w-none'
      } ${CHIP_CLASS[label]} ${isPending ? 'opacity-70' : ''}`}
      title={tip}
      role="status"
      aria-live="polite"
      aria-label={tip}
    >
      {notSafe && compactHeadline !== fullHeadline ? (
        <>
          <span className={`whitespace-nowrap text-[10px] md:hidden ${weight}`}>
            {compactHeadline}
          </span>
          <span className={`hidden whitespace-nowrap text-xs md:inline ${weight}`}>
            {fullHeadline}
          </span>
        </>
      ) : (
        <span className={`whitespace-nowrap text-[10px] md:text-xs ${weight}`}>
          {fullHeadline}
        </span>
      )}
      {subtitle ? (
        <span className="hidden whitespace-nowrap text-[9px] opacity-60 sm:block md:text-[10px]">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}
