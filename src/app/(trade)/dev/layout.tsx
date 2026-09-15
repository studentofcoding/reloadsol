import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { noIndexRobots } from '@/lib/seo'

/** All `/dev/*` tools are gated and not for search indexation. */
export const metadata: Metadata = {
  robots: noIndexRobots,
}

export default function DevLayout({ children }: { children: ReactNode }) {
  return children
}
