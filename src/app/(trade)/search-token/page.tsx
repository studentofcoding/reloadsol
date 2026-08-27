import React, { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'
import SearchTokenDispatcher from './Client'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Search Token - ReloadSOL',
  description: 'Search Solana and Robinhood tokens by name, symbol, or contract address.',
}

export default function SearchTokenPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <SearchTokenDispatcher />
    </Suspense>
  )
}
