import React, { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'
import SearchTokenRobinhoodClient from './Client'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Search Token (Robinhood) - ReloadSOL',
  description: 'Find Robinhood Chain ERC-20 tokens by name, symbol, or contract address.',
}

export default function SearchTokenRobinhoodPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <SearchTokenRobinhoodClient />
    </Suspense>
  )
}
