import React from 'react'
import { Metadata } from 'next'
import SwapRobinhoodClient from './Client'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Swap on Robinhood Chain',
  description: 'Swap individual Robinhood Chain tokens.',
  path: '/swap/robinhood',
})

export default function SwapRobinhoodPage() {
  return <SwapRobinhoodClient />
}
