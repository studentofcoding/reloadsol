import React, { Suspense } from 'react'
import BulkTokenSeller from '@/components/BulkTokenSeller'
import TokenSkeleton from '@/components/TokenSkeleton'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Reload Your SOL - ReloadSOL',
  description: 'Sell your tokens in bulk and reload your SOL. Automatically close empty token accounts to recover rent.',
  openGraph: {
    title: 'Reload Your SOL - ReloadSOL',
    description: 'Sell your tokens in bulk and reload your SOL. Automatically close empty token accounts to recover rent.',
  },
}

export default function SellPage() {
  return (
    <Suspense fallback={<TokenSkeleton count={3} variant="progressive" />}>
      <BulkTokenSeller />
    </Suspense>
  )
} 