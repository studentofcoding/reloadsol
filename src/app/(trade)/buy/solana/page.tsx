import React from 'react'
import { Metadata } from 'next'
import BuySolanaClient from './Client'
import { publicPageMetadata } from '@/lib/seo'

export const metadata: Metadata = publicPageMetadata({
  title: 'Buy tokens on Solana',
  description:
    'Buy up to 5 Solana tokens in bulk. Split your SOL across multiple tokens instantly.',
  path: '/buy/solana',
})

export default function BuySolanaPage() {
  return <BuySolanaClient />
}
