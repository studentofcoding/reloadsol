import React from 'react'
import { Metadata } from 'next'
import BuyRobinhoodClient from './Client'

export const metadata: Metadata = {
  title: 'Buy Tokens (Robinhood) - ReloadSOL',
  description: 'Buy up to 5 Robinhood Chain tokens in bulk. Split your ETH across multiple tokens.',
}

export default function BuyRobinhoodPage() {
  return <BuyRobinhoodClient />
}
