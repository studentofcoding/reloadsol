'use client'

import SegPillList from '@/components/ui/SegPillList'
import type { AppNetwork } from '@/utils/app-network'

export function InsightNetworkTabs({
  network,
  canUseRh,
  onSelect,
}: {
  network: AppNetwork
  canUseRh: boolean
  onSelect: (id: AppNetwork) => void
}) {
  return (
    <SegPillList
      variant="insight"
      ariaLabel="Insight network"
      value={network}
      onSelect={onSelect}
      options={[
        { id: 'sol', label: 'Sol' },
        { id: 'robinhood', label: 'RH', disabled: !canUseRh },
      ]}
    />
  )
}
