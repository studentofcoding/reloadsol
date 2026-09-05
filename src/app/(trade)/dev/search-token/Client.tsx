'use client'

import dynamic from 'next/dynamic'
import TokenSkeleton from '@/components/TokenSkeleton'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'
import { useSearchParams } from 'next/navigation'

const SearchTokenClient = dynamic(() => import('@/components/search/SearchTokenClient'), {
  ssr: false,
  loading: () => <TokenSkeleton count={3} variant="progressive" />,
})

export default function SearchTokenDispatcher() {
  const params = useSearchParams()
  const chainParam = params?.get('chain')
  const chain = isGmgnTradeChain(chainParam ?? '') ? chainParam : null
  return (
    <SearchTokenClient
      chain={(chain ?? undefined) as 'sol' | 'robinhood' | undefined}
      returnTo={params?.get('returnTo') ?? undefined}
      initialQuery={params?.get('initial') ?? undefined}
    />
  )
}
