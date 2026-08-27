import React, { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'
import SwapDispatcher from './Dispatcher'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Swap individual token - ReloadSOL',
  description: 'Swap individual tokens quickly and efficiently.',
  openGraph: {
    title: 'Swap individual token - ReloadSOL',
    description: 'Swap individual tokens quickly and efficiently.',
  },
}

export default function SwapPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <SwapDispatcher />
    </Suspense>
  )
}
