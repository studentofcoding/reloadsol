'use client'

import type { RiskChipData, RiskChipTone } from '@/types/risk-chip'

function toneClass(tone: RiskChipTone): string {
  if (tone === 'red') return 'border-red-500/40 bg-red-950/40 text-red-200'
  if (tone === 'amber') return 'border-amber-500/40 bg-amber-950/40 text-amber-200'
  if (tone === 'emerald')
    return 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'
  return 'border-gray-700 bg-gray-900/60 text-gray-300'
}

/** Small read-only shadow-risk chip. Renders nothing without a chip. */
export default function RiskChip({
  chip,
  className,
}: {
  chip?: RiskChipData | null
  className?: string
}) {
  if (!chip) return null
  return (
    <span
      className={`inline-flex items-center rounded border px-1 py-0.5 text-[10px] font-semibold leading-tight ${toneClass(
        chip.tone,
      )} ${className ?? ''}`}
      title={chip.reasons.join('; ')}
    >
      {chip.text}
    </span>
  )
}
