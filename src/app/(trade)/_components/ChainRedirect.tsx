'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import TokenSkeleton from '@/components/TokenSkeleton'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import type { AppNetwork } from '@/utils/app-network'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { shouldApplyUrlNetworkToStore } from '@/utils/network-switch'

/**
 * Server-side /buy can't know the user's chain (it's in localStorage).
 * The bare /buy /sell /swap pages mount this client component which reads
 * useAppNetwork().effectiveChain and router.replace's into the chain-specific
 * page. The existing <Suspense> skeleton already shows during the redirect,
 * so there's no extra flash.
 */
export default function ChainRedirect({ base }: { base: string }) {
  const router = useRouter()
  const { effectiveChain } = useAppNetwork()
  const target = `${base}/${chainSegment(effectiveChain)}`

  useEffect(() => {
    router.replace(target)
  }, [router, target])

  return <TokenSkeleton count={3} variant="progressive" />
}

function chainSegment(chain: GmgnTradeChain): string {
  return chain === 'robinhood' ? 'robinhood' : 'solana'
}

/**
 * Set the user's app network to `network` on first settle, then render children.
 * Used by per-chain /buy /sell /swap pages so that the existing monolithic
 * BulkTokenBuyer/BulkTokenSeller/SwapPageClient (which derive effectiveChain
 * from useAppNetwork) see the chain the URL declares.
 *
 * Apply once only: if this effect also depended on later `current` changes,
 * a still-mounted preface (e.g. /buy/solana) would see the header toggle's
 * setNetwork('robinhood') and snap the store back to sol before navigation
 * to /buy/robinhood completed.
 *
 * `skipCoerce: true` lets non-dev users with a connected Rabby land on
 * /buy/robinhood directly without being bounced.
 */
export function NetworkPreface({
  network,
  children,
}: {
  network: AppNetwork
  children: ReactNode
}) {
  const { network: current, setNetwork } = useAppNetwork()
  const appliedRef = useRef(false)
  useEffect(() => {
    if (
      !shouldApplyUrlNetworkToStore({
        urlNetwork: network,
        storedNetwork: current,
        alreadyApplied: appliedRef.current,
      })
    ) {
      appliedRef.current = true
      return
    }
    appliedRef.current = true
    setNetwork(network, { skipCoerce: true })
  }, [current, network, setNetwork])
  return <>{children}</>
}
