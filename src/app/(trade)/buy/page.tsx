import React, { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'
import BuyPageClient from './BuyPageClient'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Buy Multiple Tokens - ReloadSOL',
  description: 'Buy up to 10 tokens in bulk with SOL. Split your SOL across multiple tokens instantly.',
  openGraph: {
    title: 'Buy Multiple Tokens - ReloadSOL',
    description: 'Buy up to 10 tokens in bulk with SOL. Split your SOL across multiple tokens instantly.',
  },
}

export default function BuyPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <BuyPageClient />
    </Suspense>
  )
} 