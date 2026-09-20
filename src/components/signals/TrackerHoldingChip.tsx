import {
  formatHoldingUsd,
  type TrackerHolding,
} from '@/components/signals/tracker-holdings'

export function TrackerHoldingChip({
  holding,
}: {
  holding?: TrackerHolding
}) {
  if (!holding || !(holding.amount > 0)) return null
  return (
    <span
      data-testid="tracker-holding"
      className="rounded bg-amber-900/50 border border-amber-700/70 px-2 py-1 text-amber-100"
    >
      Holding: {formatHoldingUsd(holding.usd)}
    </span>
  )
}
