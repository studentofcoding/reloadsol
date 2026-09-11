'use client'

import dynamic from 'next/dynamic'
import TradingDataProvider from '@/components/TradingDataProvider'
import TokenSkeleton from '@/components/TokenSkeleton'

const BulkTokenSeller = dynamic(() => import('@/components/BulkTokenSeller'), {
  ssr: false,
  loading: () => <TokenSkeleton count={3} variant="progressive" />,
})

export default function ReloadHome() {
  return (
    <TradingDataProvider>
      <BulkTokenSeller variant="compact" />
    </TradingDataProvider>
  )
}
