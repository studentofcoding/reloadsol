import React from 'react'
import { Metadata } from 'next'
import SellSolanaClient from './Client'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Reload SOL on Solana',
  description: 'Sell Solana tokens in bulk and reload SOL.',
  path: '/sell/solana',
})

export default function SellSolanaPage() {
  return <SellSolanaClient />
}
