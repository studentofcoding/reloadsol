import React, { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'
import SearchTokenSolanaClient from './Client'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Search Token (Solana) - ReloadSOL',
  description: 'Find Solana tokens by name, symbol, or contract address.',
}

export default function SearchTokenSolanaPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <SearchTokenSolanaClient />
    </Suspense>
  )
}
