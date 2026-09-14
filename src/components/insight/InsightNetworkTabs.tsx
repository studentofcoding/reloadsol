'use client'

import InsightPressButton from '@/components/insight/InsightPressButton'
import { insightSeg, insightSegTabBase } from '@/components/insight/insight-ui'
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
  const tabs = [
    { id: 'sol' as const, label: 'Sol', disabled: false },
    { id: 'robinhood' as const, label: 'RH', disabled: !canUseRh },
  ]

  return (
    <div className={insightSeg} role="tablist" aria-label="Insight network">
      {tabs.map((tab) => {
        const selected = network === tab.id
        return (
          <InsightPressButton
            key={tab.id}
            role="tab"
            aria-selected={selected}
            disabled={tab.disabled}
            onClick={() => onSelect(tab.id)}
            className={`${insightSegTabBase} ${
              selected
                ? 'bg-white text-neutral-900 shadow-[0_1px_2px_rgba(0,0,0,0.2)]'
                : tab.disabled
                  ? 'cursor-not-allowed text-gray-600'
                  : 'text-gray-400 fine-hover:text-gray-200'
            }`}
          >
            {tab.label}
          </InsightPressButton>
        )
      })}
    </div>
  )
}
