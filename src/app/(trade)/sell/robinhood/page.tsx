import React from 'react'
import { Metadata } from 'next'
import SellRobinhoodClient from './Client'

export const metadata: Metadata = {
  title: 'Sell Tokens (Robinhood) - ReloadSOL',
  description: 'Sell your Robinhood Chain tokens in bulk and reload your ETH.',
}

export default function SellRobinhoodPage() {
  return <SellRobinhoodClient />
}
