'use client'

import React, { Suspense } from 'react'
import dynamic from 'next/dynamic'
import TokenSkeleton from '@/components/TokenSkeleton'
import { NetworkPreface } from '../../_components/ChainRedirect'

const SellPageClient = dynamic(() => import('../SellPageClient'), {
  ssr: false,
  loading: () => <TokenSkeleton count={3} variant="progressive" />,
})

export default function SellRobinhoodClient() {
  return (
    <NetworkPreface network="robinhood">
      <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
        <SellPageClient />
      </Suspense>
    </NetworkPreface>
  )
}
