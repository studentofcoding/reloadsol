import InsightPageClient from '@/components/InsightPageClient'
import type { Metadata } from 'next'
import { noIndexRobots } from '@/lib/seo'

export const metadata: Metadata = {
  title: 'Insight',
  description:
    'Per-network data-public scout and Solana roster digger. Paper notes only — this page never live-executes.',
  robots: noIndexRobots,
}

export default function InsightPage() {
  return <InsightPageClient />
}
