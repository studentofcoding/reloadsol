import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { noIndexRobots } from '@/lib/seo'

/** Per-token chart is wallet-adjacent; do not index mint URLs. */
export const metadata: Metadata = {
  title: 'Token chart',
  robots: noIndexRobots,
}

export default function ChartLayout({ children }: { children: ReactNode }) {
  return children
}
