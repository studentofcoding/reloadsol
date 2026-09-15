import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { noIndexRobots } from '@/lib/seo'

export const metadata: Metadata = {
  title: 'P&L tracker',
  robots: noIndexRobots,
}

export default function PnlLayout({ children }: { children: ReactNode }) {
  return children
}
