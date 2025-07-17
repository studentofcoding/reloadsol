import { Metadata } from 'next'
import CatchTheCoinClient from '@/components/CatchTheCoinClient'

export const metadata: Metadata = {
  title: 'Catch the Coin after reload your Solana',
  description: 'Catch trending tokens with one-click buy functionality',
}

export default function CatchTheCoinPage() {
  return <CatchTheCoinClient />
}