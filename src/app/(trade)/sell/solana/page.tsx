import React from 'react'
import { Metadata } from 'next'
import SellSolanaClient from './Client'

export const metadata: Metadata = {
  title: 'Reload SOL (Solana) - ReloadSOL',
  description: 'Sell your Solana tokens in bulk and reload your SOL.',
}

export default function SellSolanaPage() {
  return <SellSolanaClient />
}
