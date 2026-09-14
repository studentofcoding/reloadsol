'use client'

import Link from 'next/link'
import DataPublicObserveStrip from '@/components/DataPublicObserveStrip'
import RosterTab from '@/components/signals/RosterTab'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import { scoutChainFromAppNetwork } from '@/utils/data-public-scout'
import type { AppNetwork } from '@/utils/app-network'

export default function InsightPageClient() {
  const { network, setNetwork, canUseRh } = useAppNetwork()
  const scoutChain = scoutChainFromAppNetwork(network)
  const isSol = network === 'sol'

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 space-y-8">
      <div>
        <h1 className="mb-2 text-2xl font-semibold text-white">Insight</h1>
        <p className="text-sm text-gray-400">
          Per-network data-public scout plus Solana roster digger. Paper notes stay
          Safe-gated in Postgres — this page never live-executes.
        </p>
      </div>

      <div className="flex gap-1" role="tablist" aria-label="Insight network">
        {(
          [
            { id: 'sol' as const, label: 'Sol', disabled: false },
            { id: 'robinhood' as const, label: 'RH', disabled: !canUseRh },
          ] satisfies { id: AppNetwork; label: string; disabled: boolean }[]
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={network === tab.id}
            disabled={tab.disabled}
            onClick={() => setNetwork(tab.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              network === tab.id
                ? 'bg-white/10 text-white'
                : tab.disabled
                  ? 'cursor-not-allowed text-gray-600'
                  : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <DataPublicObserveStrip chain={scoutChain} />

      {isSol ? (
        <section
          className="rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-4 space-y-3"
          aria-label="Roster digger (Sol)"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-white">Roster digger (Sol)</h2>
            <Link
              href="/dev/signals?tab=roster"
              className="text-xs text-sky-300 hover:underline"
            >
              Open in Signals
            </Link>
          </div>
          <p className="text-xs text-gray-500">
            GMGN wallet digger + roster concurrence. Solana-only — not the RH scout list.
          </p>
          <RosterTab />
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
