'use client'

import dynamic from 'next/dynamic'
import TokenSkeleton from '@/components/TokenSkeleton'

const BulkTokenSeller = dynamic(() => import('@/components/BulkTokenSeller'), {
  ssr: false,
  loading: () => <TokenSkeleton count={3} variant="progressive" />,
})

export default function SellPageClient() {
  return <BulkTokenSeller />
}
