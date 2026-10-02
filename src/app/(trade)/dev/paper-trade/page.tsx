import PnlDashboardClient from '@/components/PnlDashboardClient'
import type { Metadata } from 'next'
import { noIndexRobots } from '@/lib/seo'

export const metadata: Metadata = {
  title: 'Paper PnL',
  description:
    'Daily paper-trading PnL against a SOL budget, sized by the stake and multiplier the system actually applied.',
  robots: noIndexRobots,
}

export default function PnlPage() {
  return <PnlDashboardClient />
}
