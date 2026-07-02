'use client'

import dynamic from 'next/dynamic'
import TokenSkeleton from '@/components/TokenSkeleton'

const BulkTokenBuyer = dynamic(() => import('@/components/BulkTokenBuyer'), {
  ssr: false,
  loading: () => <TokenSkeleton count={3} variant="progressive" />,
})

export default function BuyPageClient() {
  return <BulkTokenBuyer />
}
