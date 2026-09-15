import React from 'react'
import { Metadata } from 'next'
import SwapSolanaClient from './Client'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Swap on Solana',
  description: 'Swap individual Solana tokens.',
  path: '/swap/solana',
})

export default function SwapSolanaPage() {
  return <SwapSolanaClient />
}
