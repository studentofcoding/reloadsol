'use client'

import Link from 'next/link'
import DataPublicObserveStrip from '@/components/DataPublicObserveStrip'
import RosterTab from '@/components/signals/RosterTab'
import { ChevronGlyph } from '@/components/insight/InsightIcons'
import { InsightNetworkTabs } from '@/components/insight/InsightNetworkTabs'
import {
  insightCard,
  insightCardInner,
  insightEnter,
  insightEnter2,
  insightEnter3,
  insightLink,
} from '@/components/insight/insight-ui'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { scoutChainFromAppNetwork } from '@/utils/data-public-scout'

export default function InsightPageClient() {
  const { network, setNetwork, canUseRh } = useAppNetwork()
  const scoutChain = scoutChainFromAppNetwork(network)
  const isSol = network === 'sol'

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-6">
      <div className={insightEnter}>
        <h1 className="mb-2 text-2xl font-semibold text-white">Insight</h1>
        <p className="text-sm text-gray-400">
          Per-network data-public scout plus Solana roster digger. Paper notes stay
          Safe-gated in Postgres — this page never live-executes.
        </p>
      </div>

      <div className={insightEnter2}>
        <InsightNetworkTabs
          network={network}
          canUseRh={canUseRh}
          onSelect={setNetwork}
        />
      </div>

      <div className={insightEnter3}>
        <DataPublicObserveStrip chain={scoutChain} />
      </div>

      {isSol ? (
        <section
          className={`${insightCard} space-y-3 ${insightEnter3}`}
          aria-label="Roster digger (Sol)"
        >
          <div className={`${insightCardInner} px-2 pt-1`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-white">Roster digger (Sol)</h2>
              <Link href="/dev/signals?tab=roster" className={insightLink}>
                Open in Signals
                <ChevronGlyph className="size-3.5 translate-x-px" />
              </Link>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              GMGN wallet digger + roster concurrence. Solana-only — not the RH scout list.
            </p>
          </div>
          <div className={`${insightCardInner} px-1 pb-1`}>
            <RosterTab />
          </div>
        </section>
      ) : (
        <p className="text-xs text-gray-500">
          Roster digger is a Solana GMGN surface. Switch this page to Sol to open it here;
          RH insight stays on RH scout only.
        </p>
      )}
    </div>
  )
}
