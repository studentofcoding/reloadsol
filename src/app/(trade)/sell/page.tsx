import React, { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'
import SellDispatcher from './Dispatcher'
import { Metadata } from 'next'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Reload SOL',
  description:
    'Sell tokens in bulk and reload SOL. Close empty token accounts to recover rent.',
  path: '/sell',
})

export default function SellPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <SellDispatcher />
    </Suspense>
  )
}
