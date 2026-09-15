import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { noIndexRobots } from '@/lib/seo'

export const metadata: Metadata = {
  title: 'Trading history',
  robots: noIndexRobots,
}

export default function HistoryLayout({ children }: { children: ReactNode }) {
  return children
}
