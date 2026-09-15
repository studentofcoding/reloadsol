import React from 'react'
import { Metadata } from 'next'
import BuyRobinhoodClient from './Client'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Buy tokens on Robinhood Chain',
  description:
    'Buy up to 5 Robinhood Chain tokens in bulk. Split your ETH across multiple tokens.',
  path: '/buy/robinhood',
})

export default function BuyRobinhoodPage() {
  return <BuyRobinhoodClient />
}
