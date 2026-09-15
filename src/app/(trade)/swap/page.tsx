import React, { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'
import SwapDispatcher from './Dispatcher'
import { Metadata } from 'next'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Swap a token',
  description: 'Swap an individual token quickly on Solana or Robinhood Chain.',
  path: '/swap',
})

export default function SwapPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <SwapDispatcher />
    </Suspense>
  )
}
