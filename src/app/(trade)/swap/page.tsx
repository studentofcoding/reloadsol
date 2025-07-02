import React from 'react'
import { Metadata } from 'next'
import SwapPageClient from './SwapPageClient'

export const metadata: Metadata = {
  title: 'Swap Tokens - ReloadSOL',
  description: 'Swap individual tokens quickly and efficiently.',
  openGraph: {
    title: 'Swap Tokens - ReloadSOL',
    description: 'Swap individual tokens quickly and efficiently.',
  },
}

export default function SwapPage() {
  return <SwapPageClient />
} 