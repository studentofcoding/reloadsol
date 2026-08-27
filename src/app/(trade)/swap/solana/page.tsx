import React from 'react'
import { Metadata } from 'next'
import SwapSolanaClient from './Client'

export const metadata: Metadata = {
  title: 'Swap (Solana) - ReloadSOL',
  description: 'Swap individual Solana tokens via Jupiter.',
}

export default function SwapSolanaPage() {
  return <SwapSolanaClient />
}
