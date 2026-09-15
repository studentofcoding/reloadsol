import React, { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'
import BuyDispatcher from './Dispatcher'
import { Metadata } from 'next'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Buy multiple tokens',
  description:
    'Buy up to 5 tokens in bulk with SOL or ETH. Split spend across multiple tokens instantly.',
  path: '/buy',
})

export default function BuyPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <BuyDispatcher />
    </Suspense>
  )
}
