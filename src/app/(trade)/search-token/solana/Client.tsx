'use client'

import dynamic from 'next/dynamic'
import TokenSkeleton from '@/components/TokenSkeleton'
import { useSearchParams } from 'next/navigation'

const SearchTokenClient = dynamic(() => import('@/components/search/SearchTokenClient'), {
  ssr: false,
  loading: () => <TokenSkeleton count={3} variant="progressive" />,
})

export default function SearchTokenSolanaClient() {
  const params = useSearchParams()
  return (
    <SearchTokenClient
      chain="sol"
      returnTo={params?.get('returnTo') ?? undefined}
      initialQuery={params?.get('initial') ?? undefined}
    />
  )
}
