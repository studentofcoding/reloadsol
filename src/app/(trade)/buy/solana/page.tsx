import React from 'react'
import { Metadata } from 'next'
import BuySolanaClient from './Client'

export const metadata: Metadata = {
  title: 'Buy Tokens (Solana) - ReloadSOL',
  description: 'Buy up to 5 Solana tokens in bulk. Split your SOL across multiple tokens instantly.',
}

export default function BuySolanaPage() {
  return <BuySolanaClient />
}
