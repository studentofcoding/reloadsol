'use client'

import React, { Suspense } from 'react'
import dynamic from 'next/dynamic'
import TokenSkeleton from '@/components/TokenSkeleton'
import { NetworkPreface } from '../../_components/ChainRedirect'

const BuyPageClient = dynamic(() => import('../BuyPageClient'), {
  ssr: false,
  loading: () => <TokenSkeleton count={3} variant="progressive" />,
})

export default function BuySolanaClient() {
  return (
    <NetworkPreface network="sol">
      <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
        <BuyPageClient />
      </Suspense>
    </NetworkPreface>
  )
}
