import React from 'react'
import { Metadata } from 'next'
import SwapRobinhoodClient from './Client'

export const metadata: Metadata = {
  title: 'Swap (Robinhood) - ReloadSOL',
  description: 'Swap individual Robinhood Chain tokens via Kyber or GMGN.',
}

export default function SwapRobinhoodPage() {
  return <SwapRobinhoodClient />
}
