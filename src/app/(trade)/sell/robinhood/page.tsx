import React from 'react'
import { Metadata } from 'next'
import SellRobinhoodClient from './Client'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Sell tokens on Robinhood Chain',
  description: 'Sell Robinhood Chain tokens in bulk and reload ETH.',
  path: '/sell/robinhood',
})

export default function SellRobinhoodPage() {
  return <SellRobinhoodClient />
}
