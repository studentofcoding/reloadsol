'use client'

import dynamic from 'next/dynamic'
import TokenSkeleton from '@/components/TokenSkeleton'

const ChainRedirect = dynamic(() => import('../_components/ChainRedirect'), {
  ssr: false,
  loading: () => <TokenSkeleton count={3} variant="progressive" />,
})

export default function SellDispatcher() {
  return <ChainRedirect base="/sell" />
}
