import { permanentRedirect } from 'next/navigation'
import type { Metadata } from 'next'
import { noIndexRobots } from '@/lib/seo'

export const metadata: Metadata = {
  robots: noIndexRobots,
}

export default function SearchTokenSolanaRedirect() {
  permanentRedirect('/dev/search-token/solana')
}
