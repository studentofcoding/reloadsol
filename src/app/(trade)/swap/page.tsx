import React from 'react'
import { Metadata } from 'next'
import SwapPageClient from './SwapPageClient'
import { Suspense } from 'react'
import TokenSkeleton from '@/components/TokenSkeleton'

type Props = {
  searchParams: {
    input?: string
    output?: string
  }
}

export const metadata: Metadata = {
  title: 'Swap individual token - ReloadSOL',
  description: 'Swap individual tokens quickly and efficiently.',
  openGraph: {
    title: 'Swap individual token - ReloadSOL',
    description: 'Swap individual tokens quickly and efficiently.',
  },
}

export default function SwapPage({ searchParams }: Props) {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <SwapPageClient initialInputMint={searchParams.input} initialOutputMint={searchParams.output} />
    </Suspense>
  )
} 